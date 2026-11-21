const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const e = (n) => ethers.parseEther(String(n));

describe("CajuToken", function () {
  async function deploy() {
    const [admin, treasury, loja, alice, bob, hacker] = await ethers.getSigners();
    const Caju = await ethers.getContractFactory("CajuToken");
    const caju = await Caju.deploy(treasury.address);
    await caju.grantRole(await caju.MINTER_ROLE(), loja.address);
    await caju.transfer(alice.address, e(1000)); // admin é isento de taxa
    return { caju, admin, treasury, loja, alice, bob, hacker };
  }

  describe("ERC-20 básico", function () {
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

    it("rejeita tesouraria zero no constructor", async function () {
      const Caju = await ethers.getContractFactory("CajuToken");
      await expect(Caju.deploy(ethers.ZeroAddress)).to.be.revertedWith("CAJU: tesouraria invalida");
    });

    it("transferFrom respeita allowance", async function () {
      const { caju, alice, bob } = await loadFixture(deploy);
      await caju.connect(alice).approve(bob.address, e(100));
      await caju.connect(bob).transferFrom(alice.address, bob.address, e(100));
      expect(await caju.allowance(alice.address, bob.address)).to.equal(0);
      expect(await caju.balanceOf(bob.address)).to.equal(e(99)); // 1% de taxa
    });

    it("não transfere mais que o saldo", async function () {
      const { caju, alice, bob } = await loadFixture(deploy);
      await expect(caju.connect(alice).transfer(bob.address, e(5000))).to.be.reverted;
    });
  });

  describe("Taxa por transferência", function () {
    it("cobra 1% e envia para a tesouraria", async function () {
      const { caju, alice, bob, treasury } = await loadFixture(deploy);
      const antes = await caju.balanceOf(treasury.address);
      await expect(caju.connect(alice).transfer(bob.address, e(100)))
        .to.emit(caju, "TaxaCobrada").withArgs(alice.address, treasury.address, e(1));
      expect(await caju.balanceOf(bob.address)).to.equal(e(99));
      expect(await caju.balanceOf(treasury.address)).to.equal(antes + e(1));
    });

    it("previewTransfer mostra líquido e taxa", async function () {
      const { caju, alice, bob } = await loadFixture(deploy);
      const [liq, taxa] = await caju.previewTransfer(alice.address, bob.address, e(200));
      expect(liq).to.equal(e(198));
      expect(taxa).to.equal(e(2));
    });

    it("admin altera taxa, respeitando o máximo de 5%", async function () {
      const { caju, alice } = await loadFixture(deploy);
      await caju.setFeeBps(300);
      expect(await caju.feeBps()).to.equal(300);
      await expect(caju.setFeeBps(501)).to.be.revertedWith("CAJU: taxa acima do limite");
      await expect(caju.connect(alice).setFeeBps(0)).to.be.revertedWithCustomError(caju, "AccessControlUnauthorizedAccount");
    });

    it("admin troca a tesouraria (nova fica isenta e recebe as taxas)", async function () {
      const { caju, alice, bob, hacker } = await loadFixture(deploy);
      await expect(caju.setTreasury(ethers.ZeroAddress)).to.be.revertedWith("CAJU: tesouraria invalida");
      await expect(caju.setTreasury(hacker.address)).to.emit(caju, "TesourariaAlterada").withArgs(hacker.address);
      expect(await caju.isFeeExempt(hacker.address)).to.equal(true);
      await caju.connect(alice).transfer(bob.address, e(100));
      expect(await caju.balanceOf(hacker.address)).to.equal(e(1));
    });

    it("conta isenta não paga taxa", async function () {
      const { caju, alice, bob } = await loadFixture(deploy);
      await caju.setFeeExempt(bob.address, true);
      await caju.connect(alice).transfer(bob.address, e(100));
      expect(await caju.balanceOf(bob.address)).to.equal(e(100));
    });
  });

  describe("Mint / Cashback", function () {
    it("loja concede 5% de cashback (compra de R$ 200,00 = 10 CAJU)", async function () {
      const { caju, loja, bob } = await loadFixture(deploy);
      await expect(caju.connect(loja).darCashback(bob.address, 20000))
        .to.emit(caju, "CashbackConcedido").withArgs(loja.address, bob.address, 20000, e(10));
      expect(await caju.balanceOf(bob.address)).to.equal(e(10));
    });

    it("quem não é loja não emite", async function () {
      const { caju, alice } = await loadFixture(deploy);
      await expect(caju.connect(alice).darCashback(alice.address, 100))
        .to.be.revertedWithCustomError(caju, "AccessControlUnauthorizedAccount");
      await expect(caju.connect(alice).mint(alice.address, 1))
        .to.be.revertedWithCustomError(caju, "AccessControlUnauthorizedAccount");
    });

    it("valida entradas e respeita o teto de 10 milhões", async function () {
      const { caju, loja, bob } = await loadFixture(deploy);
      await expect(caju.connect(loja).darCashback(bob.address, 0)).to.be.revertedWith("CAJU: compra sem valor");
      await expect(caju.connect(loja).mint(ethers.ZeroAddress, 1)).to.be.revertedWith("CAJU: destino invalido");
      await caju.connect(loja).mint(bob.address, e(8_000_000));
      await expect(caju.connect(loja).mint(bob.address, 1)).to.be.revertedWithCustomError(caju, "ERC20ExceededCap");
    });

    it("admin ajusta o percentual de cashback", async function () {
      const { caju, loja, bob } = await loadFixture(deploy);
      await caju.setCashbackBps(1000); // 10%
      await caju.connect(loja).darCashback(bob.address, 10000); // R$100
      expect(await caju.balanceOf(bob.address)).to.equal(e(10));
      await expect(caju.setCashbackBps(2001)).to.be.revertedWith("CAJU: cashback fora do limite");
    });
  });

  describe("Burn / Resgate", function () {
    it("resgate queima tokens e registra o benefício", async function () {
      const { caju, alice } = await loadFixture(deploy);
      const supply = await caju.totalSupply();
      await expect(caju.connect(alice).resgatar(e(50), "Desconto R$50 - Mercadinho"))
        .to.emit(caju, "BeneficioResgatado").withArgs(alice.address, e(50), "Desconto R$50 - Mercadinho");
      expect(await caju.balanceOf(alice.address)).to.equal(e(950));
      expect(await caju.totalSupply()).to.equal(supply - e(50));
    });

    it("exige descrição e valor", async function () {
      const { caju, alice } = await loadFixture(deploy);
      await expect(caju.connect(alice).resgatar(e(1), "")).to.be.revertedWith("CAJU: informe o beneficio");
      await expect(caju.connect(alice).resgatar(0, "x")).to.be.revertedWith("CAJU: valor zero");
    });

    it("burn padrão do ERC20Burnable também funciona", async function () {
      const { caju, alice } = await loadFixture(deploy);
      await caju.connect(alice).burn(e(10));
      expect(await caju.balanceOf(alice.address)).to.equal(e(990));
    });
  });

  describe("Blacklist", function () {
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

    it("admin não pode ser bloqueado e só compliance bloqueia", async function () {
      const { caju, admin, alice, bob } = await loadFixture(deploy);
      await expect(caju.setBlacklist(admin.address, true)).to.be.revertedWith("CAJU: admin nao pode ser bloqueado");
      await expect(caju.connect(alice).setBlacklist(bob.address, true))
        .to.be.revertedWithCustomError(caju, "AccessControlUnauthorizedAccount");
    });
  });

  describe("Pause", function () {
    it("pausa transferências, mint e burn", async function () {
      const { caju, alice, bob, loja } = await loadFixture(deploy);
      await caju.pause();
      await expect(caju.connect(alice).transfer(bob.address, e(1))).to.be.revertedWithCustomError(caju, "EnforcedPause");
      await expect(caju.connect(loja).darCashback(bob.address, 100)).to.be.revertedWithCustomError(caju, "EnforcedPause");
      await expect(caju.connect(alice).resgatar(e(1), "x")).to.be.revertedWithCustomError(caju, "EnforcedPause");
      await caju.unpause();
      await caju.connect(alice).transfer(bob.address, e(1));
    });

    it("só PAUSER pausa", async function () {
      const { caju, alice } = await loadFixture(deploy);
      await expect(caju.connect(alice).pause()).to.be.revertedWithCustomError(caju, "AccessControlUnauthorizedAccount");
    });
  });

  describe("Staking", function () {
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

    it("rendimento continua acumulado após unstake parcial", async function () {
      const { caju, alice } = await loadFixture(deploy);
      await caju.connect(alice).stake(e(1000));
      await time.increase(182 * 24 * 60 * 60);
      await caju.connect(alice).unstake(e(500));
      expect(await caju.earned(alice.address)).to.be.closeTo(e("59.83"), e("0.05"));
    });

    it("valida stake/unstake/claim", async function () {
      const { caju, alice } = await loadFixture(deploy);
      await expect(caju.connect(alice).stake(0)).to.be.revertedWith("CAJU: valor zero");
      await expect(caju.connect(alice).unstake(e(1))).to.be.revertedWith("CAJU: stake insuficiente");
      await expect(caju.connect(alice).claimRewards()).to.be.revertedWith("CAJU: sem rendimento");
    });

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
