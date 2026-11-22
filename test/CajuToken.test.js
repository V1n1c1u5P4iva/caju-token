// Testes automatizados do CajuToken (Hardhat + Mocha/Chai), executados com `npm test`.
// Rodam numa blockchain em memória, então não gastam ETH e podem manipular o tempo
// (necessário para testar o rendimento do staking sem esperar um ano de verdade).
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

// Atalho: converte CAJU "humano" para unidades de 18 casas decimais (ex.: e(1) = 1e18).
const e = (n) => ethers.parseEther(String(n));

describe("CajuToken", function () {
  // Fixture: cenário inicial comum a todos os testes. O loadFixture executa esta função uma
  // única vez, tira um "snapshot" da blockchain e, a cada teste, volta para esse snapshot.
  // Assim cada teste começa do mesmo estado limpo (sem depender da ordem) e a suíte fica rápida.
  // Contas: admin (deployer, tem todos os papéis), tesouraria, uma loja parceira (MINTER_ROLE),
  // dois clientes (alice e bob) e um "hacker" usado nos testes de permissão e blacklist.
  async function deploy() {
    const [admin, treasury, loja, alice, bob, hacker] = await ethers.getSigners();
    const Caju = await ethers.getContractFactory("CajuToken");
    const caju = await Caju.deploy(treasury.address);
    await caju.grantRole(await caju.MINTER_ROLE(), loja.address);
    // Como o admin é isento de taxa, alice recebe exatamente 1000 CAJU (sem desconto de 1%).
    // Isso dá a ela um saldo redondo e previsível, que os testes abaixo usam nas contas.
    await caju.transfer(alice.address, e(1000)); // admin é isento de taxa
    return { caju, admin, treasury, loja, alice, bob, hacker };
  }

  // Requisitos mínimos da prova: nome, símbolo, supply e transferências do padrão ERC-20.
  describe("ERC-20 básico", function () {
    // Confere a tokenomics do constructor: 2 mi emitidos (70% admin / 30% tesouraria)
    // e teto de 10 mi. O saldo do admin desconta os 1000 CAJU enviados para alice na fixture.
    it("tem nome, símbolo, decimais e supply inicial", async function () {
      const { caju, admin, treasury } = await loadFixture(deploy);
      expect(await caju.name()).to.equal("Caju Cashback");
      expect(await caju.symbol()).to.equal("CAJU");
      expect(await caju.decimals()).to.equal(18);
      expect(await caju.totalSupply()).to.equal(e(2_000_000));
      expect(await caju.balanceOf(treasury.address)).to.equal(e(600_000));
      expect(await caju.balanceOf(admin.address)).to.equal(e(1_400_000 - 1000));
      expect(await caju.cap()).to.equal(e(10_000_000));
    });

    // Tesouraria no endereço zero faria as taxas serem enviadas para um endereço inválido;
    // o require do constructor precisa barrar o deploy nesse caso.
    it("rejeita tesouraria zero no constructor", async function () {
      const Caju = await ethers.getContractFactory("CajuToken");
      await expect(Caju.deploy(ethers.ZeroAddress)).to.be.revertedWith("CAJU: tesouraria invalida");
    });

    // transferFrom (gasto por terceiros, usado por lojas/dApps) consome a allowance e também
    // passa pela taxa, já que o contrato cobra a taxa em _update, por onde toda movimentação passa.
    it("transferFrom respeita allowance", async function () {
      const { caju, alice, bob } = await loadFixture(deploy);
      await caju.connect(alice).approve(bob.address, e(100));
      await caju.connect(bob).transferFrom(alice.address, bob.address, e(100));
      expect(await caju.allowance(alice.address, bob.address)).to.equal(0);
      expect(await caju.balanceOf(bob.address)).to.equal(e(99)); // 1% de taxa
    });

    // Alice tem 1000 e tenta enviar 5000: o ERC-20 tem de reverter, nunca criar saldo do nada.
    it("não transfere mais que o saldo", async function () {
      const { caju, alice, bob } = await loadFixture(deploy);
      await expect(caju.connect(alice).transfer(bob.address, e(5000))).to.be.reverted;
    });
  });

  // Extra 3 – Taxa: 1% de cada transferência entre usuários vai para a tesouraria.
  describe("Taxa por transferência", function () {
    // Transferência entre dois usuários comuns (nenhum isento): bob recebe 99 e a tesouraria 1,
    // e o evento TaxaCobrada fica registrado para auditoria.
    it("cobra 1% e envia para a tesouraria", async function () {
      const { caju, alice, bob, treasury } = await loadFixture(deploy);
      const antes = await caju.balanceOf(treasury.address);
      await expect(caju.connect(alice).transfer(bob.address, e(100)))
        .to.emit(caju, "TaxaCobrada").withArgs(alice.address, treasury.address, e(1));
      expect(await caju.balanceOf(bob.address)).to.equal(e(99));
      expect(await caju.balanceOf(treasury.address)).to.equal(antes + e(1));
    });

    // O frontend mostra "destinatário recebe X / taxa Y" antes de enviar. Esse teste garante
    // que a prévia usa a mesma regra da transferência real.
    it("previewTransfer mostra líquido e taxa", async function () {
      const { caju, alice, bob } = await loadFixture(deploy);
      const [liq, taxa] = await caju.previewTransfer(alice.address, bob.address, e(200));
      expect(liq).to.equal(e(198));
      expect(taxa).to.equal(e(2));
    });

    // A taxa é ajustável, mas com teto de 5% (500 bps): protege os usuários contra um admin
    // que tentasse confiscar saldo com uma taxa abusiva. E só o admin pode alterá-la.
    it("admin altera taxa, respeitando o máximo de 5%", async function () {
      const { caju, alice } = await loadFixture(deploy);
      await caju.setFeeBps(300);
      expect(await caju.feeBps()).to.equal(300);
      await expect(caju.setFeeBps(501)).to.be.revertedWith("CAJU: taxa acima do limite");
      await expect(caju.connect(alice).setFeeBps(0)).to.be.revertedWithCustomError(caju, "AccessControlUnauthorizedAccount");
    });

    // Ao trocar a tesouraria, a nova passa a receber as taxas e fica isenta automaticamente
    // (senão ela pagaria taxa sobre o próprio dinheiro ao movimentá-lo). Endereço zero é rejeitado.
    it("admin troca a tesouraria (nova fica isenta e recebe as taxas)", async function () {
      const { caju, alice, bob, hacker } = await loadFixture(deploy);
      await expect(caju.setTreasury(ethers.ZeroAddress)).to.be.revertedWith("CAJU: tesouraria invalida");
      await expect(caju.setTreasury(hacker.address)).to.emit(caju, "TesourariaAlterada").withArgs(hacker.address);
      expect(await caju.isFeeExempt(hacker.address)).to.equal(true);
      await caju.connect(alice).transfer(bob.address, e(100));
      expect(await caju.balanceOf(hacker.address)).to.equal(e(1));
    });

    // Basta um dos lados ser isento para não haver taxa. Serve, por exemplo, para lojas
    // parceiras receberem pagamentos em CAJU sem perder 1%.
    it("conta isenta não paga taxa", async function () {
      const { caju, alice, bob } = await loadFixture(deploy);
      await caju.setFeeExempt(bob.address, true);
      await caju.connect(alice).transfer(bob.address, e(100));
      expect(await caju.balanceOf(bob.address)).to.equal(e(100));
    });
  });

  // Extra 1 – Mint: lojas parceiras emitem CAJU como cashback das compras.
  describe("Mint / Cashback", function () {
    // O valor da compra entra em centavos (inteiro, pois Solidity não tem ponto flutuante):
    // 20000 centavos = R$ 200,00 × 5% = 10 CAJU. O evento guarda loja, cliente e valor da compra.
    it("loja concede 5% de cashback (compra de R$ 200,00 = 10 CAJU)", async function () {
      const { caju, loja, bob } = await loadFixture(deploy);
      await expect(caju.connect(loja).darCashback(bob.address, 20000))
        .to.emit(caju, "CashbackConcedido").withArgs(loja.address, bob.address, 20000, e(10));
      expect(await caju.balanceOf(bob.address)).to.equal(e(10));
    });

    // Teste de segurança mais importante do mint: se qualquer um pudesse emitir, o token não
    // valeria nada. Tanto darCashback quanto mint exigem MINTER_ROLE.
    it("quem não é loja não emite", async function () {
      const { caju, alice } = await loadFixture(deploy);
      await expect(caju.connect(alice).darCashback(alice.address, 100))
        .to.be.revertedWithCustomError(caju, "AccessControlUnauthorizedAccount");
      await expect(caju.connect(alice).mint(alice.address, 1))
        .to.be.revertedWithCustomError(caju, "AccessControlUnauthorizedAccount");
    });

    // Valida as entradas e o teto: como já existem 2 mi, emitir 8 mi chega exatamente aos
    // 10 mi; 1 unidade a mais tem de ser recusada pelo ERC20Capped, mesmo vindo de uma loja autorizada.
    it("valida entradas e respeita o teto de 10 milhões", async function () {
      const { caju, loja, bob } = await loadFixture(deploy);
      await expect(caju.connect(loja).darCashback(bob.address, 0)).to.be.revertedWith("CAJU: compra sem valor");
      await expect(caju.connect(loja).mint(ethers.ZeroAddress, 1)).to.be.revertedWith("CAJU: destino invalido");
      await caju.connect(loja).mint(bob.address, e(8_000_000));
      await expect(caju.connect(loja).mint(bob.address, 1)).to.be.revertedWithCustomError(caju, "ERC20ExceededCap");
    });

    // Percentual ajustável (ex.: campanhas de 10%), com limite de 20% para não inflacionar o token.
    it("admin ajusta o percentual de cashback", async function () {
      const { caju, loja, bob } = await loadFixture(deploy);
      await caju.setCashbackBps(1000); // 10%
      await caju.connect(loja).darCashback(bob.address, 10000); // R$100
      expect(await caju.balanceOf(bob.address)).to.equal(e(10));
      await expect(caju.setCashbackBps(2001)).to.be.revertedWith("CAJU: cashback fora do limite");
    });
  });

  // Extra 2 – Burn: resgatar um benefício queima os tokens (mecanismo deflacionário).
  describe("Burn / Resgate", function () {
    // Além de reduzir o saldo, o totalSupply precisa cair: os tokens deixam de existir,
    // e não simplesmente vão para outra carteira. O evento registra qual benefício foi resgatado.
    it("resgate queima tokens e registra o benefício", async function () {
      const { caju, alice } = await loadFixture(deploy);
      const supply = await caju.totalSupply();
      await expect(caju.connect(alice).resgatar(e(50), "Desconto R$50 - Mercadinho"))
        .to.emit(caju, "BeneficioResgatado").withArgs(alice.address, e(50), "Desconto R$50 - Mercadinho");
      expect(await caju.balanceOf(alice.address)).to.equal(e(950));
      expect(await caju.totalSupply()).to.equal(supply - e(50));
    });

    // Sem descrição a loja não saberia qual benefício entregar; resgate de 0 seria spam de eventos.
    it("exige descrição e valor", async function () {
      const { caju, alice } = await loadFixture(deploy);
      await expect(caju.connect(alice).resgatar(e(1), "")).to.be.revertedWith("CAJU: informe o beneficio");
      await expect(caju.connect(alice).resgatar(0, "x")).to.be.revertedWith("CAJU: valor zero");
    });

    // Garante que a herança do ERC20Burnable continua funcionando junto com o _update customizado.
    it("burn padrão do ERC20Burnable também funciona", async function () {
      const { caju, alice } = await loadFixture(deploy);
      await caju.connect(alice).burn(e(10));
      expect(await caju.balanceOf(alice.address)).to.equal(e(990));
    });
  });

  // Extra 4 – Blacklist: congela carteiras envolvidas em fraude.
  describe("Blacklist", function () {
    // O bloqueio vale nos dois sentidos (a carteira não envia nem recebe) e é reversível:
    // depois de desbloqueada, a carteira volta a transferir normalmente.
    it("bloqueia envio e recebimento", async function () {
      const { caju, alice, hacker } = await loadFixture(deploy);
      await caju.transfer(hacker.address, e(10));
      await expect(caju.setBlacklist(hacker.address, true))
        .to.emit(caju, "BlacklistAtualizada").withArgs(hacker.address, true);
      await expect(caju.connect(hacker).transfer(alice.address, e(1))).to.be.revertedWith("CAJU: endereco bloqueado");
      await expect(caju.connect(alice).transfer(hacker.address, e(1))).to.be.revertedWith("CAJU: endereco bloqueado");
      await caju.setBlacklist(hacker.address, false);
      await caju.connect(hacker).transfer(alice.address, e(1));
    });

    // Proteções do próprio mecanismo: não é possível bloquear um admin (evita que alguém com
    // COMPLIANCE_ROLE trave a administração do token), e só COMPLIANCE_ROLE pode bloquear.
    it("admin não pode ser bloqueado e só compliance bloqueia", async function () {
      const { caju, admin, alice, bob } = await loadFixture(deploy);
      await expect(caju.setBlacklist(admin.address, true)).to.be.revertedWith("CAJU: admin nao pode ser bloqueado");
      await expect(caju.connect(alice).setBlacklist(bob.address, true))
        .to.be.revertedWithCustomError(caju, "AccessControlUnauthorizedAccount");
    });
  });

  // Extra 5 – Pause: "botão de emergência" (ex.: se um bug for descoberto).
  describe("Pause", function () {
    // Pausado, nenhuma movimentação passa: transferência, emissão (cashback) e queima (resgate),
    // porque todas passam por _update. Depois do unpause tudo volta ao normal.
    it("pausa transferências, mint e burn", async function () {
      const { caju, alice, bob, loja } = await loadFixture(deploy);
      await caju.pause();
      await expect(caju.connect(alice).transfer(bob.address, e(1))).to.be.revertedWithCustomError(caju, "EnforcedPause");
      await expect(caju.connect(loja).darCashback(bob.address, 100)).to.be.revertedWithCustomError(caju, "EnforcedPause");
      await expect(caju.connect(alice).resgatar(e(1), "x")).to.be.revertedWithCustomError(caju, "EnforcedPause");
      await caju.unpause();
      await caju.connect(alice).transfer(bob.address, e(1));
    });

    // Um usuário comum não pode congelar o token de todos.
    it("só PAUSER pausa", async function () {
      const { caju, alice } = await loadFixture(deploy);
      await expect(caju.connect(alice).pause()).to.be.revertedWithCustomError(caju, "AccessControlUnauthorizedAccount");
    });
  });

  // Extra 6 – Staking: CAJU travado no contrato rende 12% ao ano, calculado por segundo.
  describe("Staking", function () {
    // Ciclo completo. O stake não paga taxa (o contrato é isento), então os 1000 inteiros ficam
    // travados. time.increase avança 1 ano no relógio da blockchain local: 1000 × 12% = 120.
    // closeTo tolera uma diferença mínima, pois cada transação avança alguns segundos a mais.
    it("stake sem taxa, rende 12% ao ano e permite sacar", async function () {
      const { caju, alice } = await loadFixture(deploy);
      await expect(caju.connect(alice).stake(e(1000))).to.emit(caju, "Staked").withArgs(alice.address, e(1000));
      expect(await caju.balanceOf(alice.address)).to.equal(0);
      expect(await caju.totalStaked()).to.equal(e(1000));

      await time.increase(365 * 24 * 60 * 60);
      const rend = await caju.earned(alice.address);
      expect(rend).to.be.closeTo(e(120), e("0.01"));

      await caju.connect(alice).claimRewards();
      expect(await caju.balanceOf(alice.address)).to.be.closeTo(e(120), e("0.01"));

      await caju.connect(alice).unstake(e(1000));
      expect(await caju.totalStaked()).to.equal(0);
      expect(await caju.balanceOf(alice.address)).to.be.closeTo(e(1120), e("0.01"));
    });

    // Retirar parte do stake não pode apagar o que já rendeu: o modifier atualizaRendimento
    // "fecha a conta" antes de mudar o valor travado. 1000 × 12% × 182/365 ≈ 59,83 CAJU.
    it("rendimento continua acumulado após unstake parcial", async function () {
      const { caju, alice } = await loadFixture(deploy);
      await caju.connect(alice).stake(e(1000));
      await time.increase(182 * 24 * 60 * 60);
      await caju.connect(alice).unstake(e(500));
      expect(await caju.earned(alice.address)).to.be.closeTo(e("59.83"), e("0.05"));
    });

    // Entradas inválidas: stake zero, retirar mais do que está travado, sacar sem ter rendimento.
    it("valida stake/unstake/claim", async function () {
      const { caju, alice } = await loadFixture(deploy);
      await expect(caju.connect(alice).stake(0)).to.be.revertedWith("CAJU: valor zero");
      await expect(caju.connect(alice).unstake(e(1))).to.be.revertedWith("CAJU: stake insuficiente");
      await expect(caju.connect(alice).claimRewards()).to.be.revertedWith("CAJU: sem rendimento");
    });

    // O rendimento é pago com tokens novos (mint), então poderia furar o teto de 10 mi.
    // Cenário: sobram só 5 CAJU até o teto e alice tem ~120 a receber. O saque paga apenas os 5,
    // o supply para exatamente no teto, o restante continua registrado como pendente
    // (não é perdido) e novos saques são recusados. Assim o MAX_SUPPLY vale sempre, sem travar o contrato.
    it("rendimento nunca ultrapassa o teto de supply", async function () {
      const { caju, alice, loja } = await loadFixture(deploy);
      await caju.connect(alice).stake(e(1000));
      await caju.connect(loja).mint(loja.address, e(8_000_000) - e(5)); // sobram 5 CAJU
      await time.increase(365 * 24 * 60 * 60);
      await caju.connect(alice).claimRewards();
      expect(await caju.totalSupply()).to.equal(await caju.cap());
      expect(await caju.earned(alice.address)).to.be.gt(0); // resto fica pendente
      await expect(caju.connect(alice).claimRewards()).to.be.revertedWith("CAJU: teto de emissao atingido");
    });
  });
});
