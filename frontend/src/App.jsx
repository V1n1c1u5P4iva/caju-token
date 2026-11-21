import { useCallback, useEffect, useMemo, useState } from "react";
import { BrowserProvider, Contract, formatUnits, parseUnits, isAddress, ZeroHash } from "ethers";
import info from "./contract.json";

// ---------------------------------------------------------------------------
// Configuração de rede
// ---------------------------------------------------------------------------
const CHAINS = {
  11155111: {
    hex: "0xaa36a7",
    name: "Sepolia",
    explorer: "https://sepolia.etherscan.io",
    params: {
      chainId: "0xaa36a7",
      chainName: "Sepolia",
      nativeCurrency: { name: "Sepolia ETH", symbol: "ETH", decimals: 18 },
      rpcUrls: ["https://ethereum-sepolia-rpc.publicnode.com"],
      blockExplorerUrls: ["https://sepolia.etherscan.io"],
    },
  },
  31337: { hex: "0x7a69", name: "Hardhat local", explorer: null, params: null },
};
const TARGET = CHAINS[info.chainId] ?? CHAINS[11155111];
const YEAR = 365 * 24 * 60 * 60;

const BENEFICIOS = [
  { nome: "Suco de caju grátis · Lanchonete Central", custo: 5 },
  { nome: "Frete grátis · Delivery Teresina", custo: 8 },
  { nome: "Desconto R$ 10 · Mercadinho Bom Preço", custo: 10 },
  { nome: "Cajuína 1L · Empório do Piauí", custo: 15 },
  { nome: "Desconto R$ 50 · Farmácia Popular do Bairro", custo: 50 },
];

// ---------------------------------------------------------------------------
// Utilitários
// ---------------------------------------------------------------------------
const fmt = (v, dec = 2) => {
  if (v === undefined || v === null) return "—";
  const n = Number(formatUnits(v, 18));
  return n.toLocaleString("pt-BR", { minimumFractionDigits: dec, maximumFractionDigits: dec });
};
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");
const txLink = (h) => (TARGET.explorer ? `${TARGET.explorer}/tx/${h}` : null);
const addrLink = (a) => (TARGET.explorer ? `${TARGET.explorer}/address/${a}` : null);

function parseError(err) {
  const msg =
    err?.reason ||
    err?.info?.error?.message ||
    err?.shortMessage ||
    err?.message ||
    "Erro desconhecido";
  if (/user (rejected|denied)/i.test(msg) || err?.code === "ACTION_REJECTED") return "Transação cancelada na MetaMask.";
  if (/EnforcedPause/.test(msg) || err?.revert?.name === "EnforcedPause") return "O token está pausado.";
  if (/AccessControlUnauthorizedAccount/.test(msg) || err?.revert?.name === "AccessControlUnauthorizedAccount")
    return "Sua carteira não tem permissão para isso.";
  if (/ERC20InsufficientBalance/.test(msg) || err?.revert?.name === "ERC20InsufficientBalance") return "Saldo insuficiente.";
  if (/ERC20ExceededCap/.test(msg)) return "Teto de 10 milhões de CAJU atingido.";
  return msg.replace(/^execution reverted: /, "");
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
export default function App() {
  const [account, setAccount] = useState(null);
  const [chainId, setChainId] = useState(null);
  const [contract, setContract] = useState(null);
  const [data, setData] = useState(null);
  const [activity, setActivity] = useState([]);
  const [busy, setBusy] = useState(null);
  const [toast, setToast] = useState(null);
  const [now, setNow] = useState(Math.floor(Date.now() / 1000));

  const hasWallet = typeof window !== "undefined" && !!window.ethereum;
  const wrongNetwork = account && chainId !== info.chainId;

  // ---- Conexão --------------------------------------------------------------
  const setup = useCallback(async () => {
    if (!window.ethereum) return;
    const provider = new BrowserProvider(window.ethereum);
    const accounts = await provider.send("eth_accounts", []);
    const net = await provider.getNetwork();
    setChainId(Number(net.chainId));
    if (!accounts.length) {
      setAccount(null);
      setContract(null);
      return;
    }
    const signer = await provider.getSigner();
    setAccount(await signer.getAddress());
    setContract(new Contract(info.address, info.abi, signer));
  }, []);

  const connect = async () => {
    if (!window.ethereum) return;
    try {
      await window.ethereum.request({ method: "eth_requestAccounts" });
      await setup();
    } catch (err) {
      setToast({ type: "error", text: parseError(err) });
    }
  };

  const switchNetwork = async () => {
    try {
      await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: TARGET.hex }] });
    } catch (err) {
      if (err.code === 4902 && TARGET.params) {
        await window.ethereum.request({ method: "wallet_addEthereumChain", params: [TARGET.params] });
      } else setToast({ type: "error", text: parseError(err) });
    }
  };

  const addToMetaMask = async () => {
    try {
      await window.ethereum.request({
        method: "wallet_watchAsset",
        params: { type: "ERC20", options: { address: info.address, symbol: "CAJU", decimals: 18 } },
      });
    } catch (err) {
      setToast({ type: "error", text: parseError(err) });
    }
  };

  useEffect(() => {
    if (!window.ethereum) return;
    setup();
    const reload = () => setup();
    window.ethereum.on?.("accountsChanged", reload);
    window.ethereum.on?.("chainChanged", reload);
    return () => {
      window.ethereum.removeListener?.("accountsChanged", reload);
      window.ethereum.removeListener?.("chainChanged", reload);
    };
  }, [setup]);

  // ---- Leitura do contrato --------------------------------------------------
  const refresh = useCallback(async () => {
    if (!contract || !account || chainId !== info.chainId) return;
    try {
      const [MINTER, PAUSER, COMPLIANCE] = await Promise.all([
        contract.MINTER_ROLE(),
        contract.PAUSER_ROLE(),
        contract.COMPLIANCE_ROLE(),
      ]);
      const [
        balance, stake, earned, totalSupply, cap, totalStaked, feeBps, cashbackBps, paused,
        blacklisted, treasury, isAdmin, isMinter, isPauser, isCompliance, eth,
      ] = await Promise.all([
        contract.balanceOf(account),
        contract.stakes(account),
        contract.earned(account),
        contract.totalSupply(),
        contract.cap(),
        contract.totalStaked(),
        contract.feeBps(),
        contract.cashbackBps(),
        contract.paused(),
        contract.isBlacklisted(account),
        contract.treasury(),
        contract.hasRole(ZeroHash, account),
        contract.hasRole(MINTER, account),
        contract.hasRole(PAUSER, account),
        contract.hasRole(COMPLIANCE, account),
        contract.runner.provider.getBalance(account),
      ]);
      setData({
        balance, staked: stake.amount, earned, totalSupply, cap, totalStaked,
        feeBps: Number(feeBps), cashbackBps: Number(cashbackBps), paused, blacklisted, treasury, eth,
        fetchedAt: Math.floor(Date.now() / 1000),
        roles: { admin: isAdmin, minter: isMinter, pauser: isPauser, compliance: isCompliance },
      });
    } catch (err) {
      setToast({ type: "error", text: "Não foi possível ler o contrato. Confira a rede e o endereço em contract.json." });
      console.error(err);
    }
  }, [contract, account, chainId]);

  const loadActivity = useCallback(async () => {
    if (!contract || !account || chainId !== info.chainId) return;
    try {
      const provider = contract.runner.provider;
      const latest = await provider.getBlockNumber();
      const from = Math.max(info.deployBlock ?? 0, latest - 45_000);
      const f = contract.filters;
      const [sent, received, cashbacks, resgates, stakesEv, unstakes, rewards] = await Promise.all([
        contract.queryFilter(f.Transfer(account, null), from),
        contract.queryFilter(f.Transfer(null, account), from),
        contract.queryFilter(f.CashbackConcedido(null, account), from),
        contract.queryFilter(f.BeneficioResgatado(account), from),
        contract.queryFilter(f.Staked(account), from),
        contract.queryFilter(f.Unstaked(account), from),
        contract.queryFilter(f.RendimentoSacado(account), from),
      ]);
      const special = new Set([...cashbacks, ...resgates, ...stakesEv, ...unstakes, ...rewards].map((e) => e.transactionHash));
      const items = [];
      const push = (e, kind, label, amount, sign) =>
        items.push({ key: `${e.transactionHash}-${e.index}`, hash: e.transactionHash, block: e.blockNumber, kind, label, amount, sign });

      cashbacks.forEach((e) => push(e, "cashback", `Cashback de compra R$ ${(Number(e.args.valorCompraCentavos) / 100).toFixed(2)}`, e.args.tokens, "+"));
      resgates.forEach((e) => push(e, "resgate", e.args.beneficio, e.args.tokens, "−"));
      stakesEv.forEach((e) => push(e, "stake", "Colocou em staking", e.args.valor, "→"));
      unstakes.forEach((e) => push(e, "stake", "Retirou do staking", e.args.valor, "←"));
      rewards.forEach((e) => push(e, "reward", "Rendimento de staking", e.args.valor, "+"));
      sent.filter((e) => !special.has(e.transactionHash) && e.args.to !== data?.treasury)
        .forEach((e) => push(e, "out", `Enviado para ${short(e.args.to)}`, e.args.value, "−"));
      received.filter((e) => !special.has(e.transactionHash) && e.args.from !== "0x0000000000000000000000000000000000000000")
        .forEach((e) => push(e, "in", `Recebido de ${short(e.args.from)}`, e.args.value, "+"));

      items.sort((a, b) => b.block - a.block);
      setActivity(items.slice(0, 12));
    } catch (err) {
      console.warn("Histórico indisponível:", err);
    }
  }, [contract, account, chainId, data?.treasury]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (data) loadActivity();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.fetchedAt]);

  // relógio para o rendimento "ao vivo"
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);

  const liveEarned = useMemo(() => {
    if (!data) return 0n;
    const dt = BigInt(Math.max(0, now - data.fetchedAt));
    return data.earned + (data.staked * 1200n * dt) / (10000n * BigInt(YEAR));
  }, [data, now]);

  // ---- Envio de transações ---------------------------------------------------
  const run = async (label, fn) => {
    setBusy(label);
    setToast({ type: "info", text: `${label}: confirme na MetaMask…` });
    try {
      const tx = await fn();
      setToast({ type: "info", text: `${label}: aguardando confirmação no bloco…`, hash: tx.hash });
      const r = await tx.wait();
      setToast({ type: "ok", text: `✓ ${label} · confirmado no bloco ${r.blockNumber} · ${r.gasUsed.toLocaleString("pt-BR")} gas`, hash: tx.hash });
      await refresh();
      return true;
    } catch (err) {
      setToast({ type: "error", text: parseError(err) });
      return false;
    } finally {
      setBusy(null);
    }
  };

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  const anyRole = data && Object.values(data.roles).some(Boolean);
  const supplyPct = data ? Number((data.totalSupply * 10000n) / data.cap) / 100 : 0;

  return (
    <div className="page">
      <header className="top">
        <div className="brand">
          <CajuMark />
          <div>
            <h1>CAJU</h1>
            <span>Cashback do comércio piauiense</span>
          </div>
        </div>
        <div className="top-actions">
          {account && data?.paused && <span className="pill pill-warn">Token pausado</span>}
          {account && !wrongNetwork && <span className="pill">{TARGET.name}</span>}
          {account ? (
            <a className="wallet" href={addrLink(account) ?? undefined} target="_blank" rel="noreferrer">
              <span className="dot" /> {short(account)}
            </a>
          ) : (
            <button className="btn btn-primary" onClick={connect} disabled={!hasWallet}>
              Conectar MetaMask
            </button>
          )}
        </div>
      </header>

      {!hasWallet && (
        <Notice>
          MetaMask não encontrada. Instale em <a href="https://metamask.io/download" target="_blank" rel="noreferrer">metamask.io</a> e recarregue a página.
        </Notice>
      )}

      {!account && hasWallet && <Hero onConnect={connect} />}

      {wrongNetwork && (
        <Notice>
          Você está na rede errada. O CAJU vive na <b>{TARGET.name}</b>.{" "}
          <button className="btn btn-small" onClick={switchNetwork}>Trocar para {TARGET.name}</button>
        </Notice>
      )}

      {account && !wrongNetwork && data?.blacklisted && (
        <Notice tone="danger">Esta carteira está bloqueada (blacklist) e não pode movimentar CAJU.</Notice>
      )}

      {account && !wrongNetwork && data && (
        <main className="grid">
          {/* Saldo principal */}
          <section className="card balance-card">
            <div className="label">Seu saldo</div>
            <div className="big">
              {fmt(data.balance)} <small>CAJU</small>
            </div>
            <div className="sub">≈ R$ {fmt(data.balance)} em benefícios · {Number(formatUnits(data.eth, 18)).toFixed(4)} ETH para gas</div>
            <div className="row-actions">
              <button className="btn btn-ghost-light" onClick={addToMetaMask}>+ Adicionar CAJU à MetaMask</button>
              {addrLink(info.address) && (
                <a className="btn btn-ghost-light" href={addrLink(info.address)} target="_blank" rel="noreferrer">Ver contrato ↗</a>
              )}
            </div>
          </section>

          {/* Estatísticas */}
          <section className="card stats">
            <Stat label="Em staking" value={`${fmt(data.staked)} CAJU`} />
            <Stat label="Rendimento (12% a.a.)" value={`${fmt(liveEarned, 6)} CAJU`} live={data.staked > 0n} />
            <Stat label="Taxa por transferência" value={`${(data.feeBps / 100).toFixed(2)}%`} />
            <Stat label="Cashback das lojas" value={`${(data.cashbackBps / 100).toFixed(2)}%`} />
            <div className="supply">
              <div className="supply-head">
                <span>Supply emitido</span>
                <span className="mono">{fmt(data.totalSupply, 0)} / {fmt(data.cap, 0)}</span>
              </div>
              <div className="bar"><div style={{ width: `${Math.max(supplyPct, 1)}%` }} /></div>
              <div className="supply-foot">{supplyPct.toFixed(2)}% do teto · {fmt(data.totalStaked, 0)} CAJU travados em staking</div>
            </div>
          </section>

          <TransferCard contract={contract} account={account} data={data} run={run} busy={busy} />
          <StakingCard contract={contract} data={data} liveEarned={liveEarned} run={run} busy={busy} />
          <ResgateCard contract={contract} data={data} run={run} busy={busy} />
          <ActivityCard items={activity} />

          {anyRole && <AdminCard contract={contract} data={data} run={run} busy={busy} />}
        </main>
      )}

      {toast && (
        <div className={`toast toast-${toast.type}`} onClick={() => setToast(null)}>
          <span>{toast.text}</span>
          {toast.hash && txLink(toast.hash) && (
            <a href={txLink(toast.hash)} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
              Ver no Etherscan ↗
            </a>
          )}
        </div>
      )}

      <footer className="foot">
        Contrato <span className="mono">{short(info.address)}</span> · ERC-20 com OpenZeppelin · Projeto acadêmico UESPI · Blockchain, Smart Contracts e Web3
      </footer>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cartões
// ---------------------------------------------------------------------------
function TransferCard({ contract, account, data, run, busy }) {
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [preview, setPreview] = useState(null);

  useEffect(() => {
    let alive = true;
    const go = async () => {
      if (!isAddress(to) || !(Number(amount) > 0)) return setPreview(null);
      try {
        const [liq, taxa] = await contract.previewTransfer(account, to, parseUnits(amount, 18));
        if (alive) setPreview({ liq, taxa });
      } catch {
        if (alive) setPreview(null);
      }
    };
    const t = setTimeout(go, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [to, amount, contract, account, data.feeBps]);

  const invalid = !isAddress(to) || !(Number(amount) > 0);
  const submit = async (e) => {
    e.preventDefault();
    const ok = await run("Transferência", () => contract.transfer(to, parseUnits(amount, 18)));
    if (ok) setAmount("");
  };

  return (
    <section className="card">
      <h2>Transferir</h2>
      <form onSubmit={submit} className="form">
        <label>
          Destinatário
          <input placeholder="0x…" value={to} onChange={(e) => setTo(e.target.value.trim())} />
        </label>
        <label>
          Quantidade
          <div className="input-suffix">
            <input type="number" min="0" step="any" placeholder="0,00" value={amount} onChange={(e) => setAmount(e.target.value)} />
            <button type="button" className="link" onClick={() => setAmount(formatUnits(data.balance, 18))}>máx</button>
          </div>
        </label>
        {preview && (
          <div className="preview">
            <div><span>Destinatário recebe</span><b>{fmt(preview.liq, 4)} CAJU</b></div>
            <div><span>Taxa para tesouraria</span><b>{fmt(preview.taxa, 4)} CAJU</b></div>
          </div>
        )}
        <button className="btn btn-primary" disabled={invalid || !!busy || data.paused}>
          {busy === "Transferência" ? "Enviando…" : "Enviar CAJU"}
        </button>
      </form>
    </section>
  );
}

function StakingCard({ contract, data, liveEarned, run, busy }) {
  const [amount, setAmount] = useState("");
  const valid = Number(amount) > 0;
  const projAno = valid ? (Number(amount) * 0.12).toLocaleString("pt-BR", { maximumFractionDigits: 2 }) : null;

  return (
    <section className="card">
      <h2>Staking <span className="tag">12% ao ano</span></h2>
      <p className="muted">Trave CAJU no contrato e ganhe rendimento por segundo. Sem taxa para entrar ou sair.</p>
      <div className="form">
        <label>
          Quantidade
          <input type="number" min="0" step="any" placeholder="0,00" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </label>
        {projAno && <div className="hint">Rende ≈ {projAno} CAJU em 1 ano</div>}
        <div className="btn-row">
          <button className="btn btn-primary" disabled={!valid || !!busy || data.paused}
            onClick={() => run("Stake", () => contract.stake(parseUnits(amount, 18))).then((ok) => ok && setAmount(""))}>
            Fazer stake
          </button>
          <button className="btn btn-outline" disabled={!valid || !!busy || data.paused}
            onClick={() => run("Unstake", () => contract.unstake(parseUnits(amount, 18))).then((ok) => ok && setAmount(""))}>
            Retirar
          </button>
        </div>
        <div className="claim">
          <div>
            <div className="label">Rendimento disponível</div>
            <div className="mono claim-val">{fmt(liveEarned, 6)} CAJU</div>
          </div>
          <button className="btn btn-green" disabled={liveEarned === 0n || !!busy || data.paused}
            onClick={() => run("Saque de rendimento", () => contract.claimRewards())}>
            Sacar
          </button>
        </div>
      </div>
    </section>
  );
}

function ResgateCard({ contract, data, run, busy }) {
  const [sel, setSel] = useState(0);
  const b = BENEFICIOS[sel];
  const enough = data.balance >= parseUnits(String(b.custo), 18);

  return (
    <section className="card">
      <h2>Resgatar benefícios</h2>
      <p className="muted">O resgate queima (burn) os tokens — o supply diminui e o benefício fica registrado na blockchain.</p>
      <div className="benefits">
        {BENEFICIOS.map((x, i) => (
          <button key={x.nome} className={`benefit ${i === sel ? "on" : ""}`} onClick={() => setSel(i)}>
            <span>{x.nome}</span>
            <b>{x.custo} CAJU</b>
          </button>
        ))}
      </div>
      <button className="btn btn-primary full" disabled={!enough || !!busy || data.paused}
        onClick={() => run("Resgate", () => contract.resgatar(parseUnits(String(b.custo), 18), b.nome))}>
        {enough ? `Resgatar por ${b.custo} CAJU` : "Saldo insuficiente"}
      </button>
    </section>
  );
}

function ActivityCard({ items }) {
  return (
    <section className="card">
      <h2>Atividade recente</h2>
      {!items.length && <p className="muted">Nenhuma movimentação ainda. Faça uma transferência ou receba cashback.</p>}
      <ul className="activity">
        {items.map((it) => (
          <li key={it.key}>
            <span className={`ico ico-${it.kind}`}>{it.sign}</span>
            <span className="act-label">{it.label}</span>
            <span className="mono act-amt">{fmt(it.amount)}</span>
            {txLink(it.hash) && <a href={txLink(it.hash)} target="_blank" rel="noreferrer">↗</a>}
          </li>
        ))}
      </ul>
    </section>
  );
}

function AdminCard({ contract, data, run, busy }) {
  const { roles } = data;
  const [cliente, setCliente] = useState("");
  const [compra, setCompra] = useState("");
  const [mintTo, setMintTo] = useState("");
  const [mintAmt, setMintAmt] = useState("");
  const [blAddr, setBlAddr] = useState("");
  const [blStatus, setBlStatus] = useState(null);
  const [fee, setFee] = useState("");

  useEffect(() => {
    if (!isAddress(blAddr)) return setBlStatus(null);
    contract.isBlacklisted(blAddr).then(setBlStatus).catch(() => setBlStatus(null));
  }, [blAddr, contract, data.fetchedAt]);

  const cashbackPreview = Number(compra) > 0 ? ((Number(compra) * data.cashbackBps) / 10000).toLocaleString("pt-BR", { maximumFractionDigits: 2 }) : null;

  return (
    <section className="card admin">
      <h2>Painel da loja / administração</h2>
      <div className="roles">
        {roles.admin && <span className="pill">Admin</span>}
        {roles.minter && <span className="pill">Loja parceira (mint)</span>}
        {roles.pauser && <span className="pill">Pauser</span>}
        {roles.compliance && <span className="pill">Compliance</span>}
      </div>
      <div className="admin-grid">
        {roles.minter && (
          <div className="sub-card">
            <h3>Registrar compra e dar cashback</h3>
            <input placeholder="Carteira do cliente 0x…" value={cliente} onChange={(e) => setCliente(e.target.value.trim())} />
            <input type="number" min="0" step="0.01" placeholder="Valor da compra (R$)" value={compra} onChange={(e) => setCompra(e.target.value)} />
            {cashbackPreview && <div className="hint">Cliente recebe {cashbackPreview} CAJU</div>}
            <button className="btn btn-primary" disabled={!isAddress(cliente) || !(Number(compra) > 0) || !!busy}
              onClick={() => run("Cashback", () => contract.darCashback(cliente, Math.round(Number(compra) * 100)))}>
              Conceder cashback
            </button>
          </div>
        )}
        {roles.minter && (
          <div className="sub-card">
            <h3>Mint (campanhas e premiações)</h3>
            <input placeholder="Destino 0x…" value={mintTo} onChange={(e) => setMintTo(e.target.value.trim())} />
            <input type="number" min="0" step="any" placeholder="Quantidade CAJU" value={mintAmt} onChange={(e) => setMintAmt(e.target.value)} />
            <button className="btn btn-primary" disabled={!isAddress(mintTo) || !(Number(mintAmt) > 0) || !!busy}
              onClick={() => run("Mint", () => contract.mint(mintTo, parseUnits(mintAmt, 18)))}>
              Emitir
            </button>
          </div>
        )}
        {roles.compliance && (
          <div className="sub-card">
            <h3>Blacklist</h3>
            <input placeholder="Carteira 0x…" value={blAddr} onChange={(e) => setBlAddr(e.target.value.trim())} />
            {blStatus !== null && <div className="hint">Situação: {blStatus ? "🔒 bloqueada" : "✅ liberada"}</div>}
            <button className="btn btn-outline" disabled={!isAddress(blAddr) || blStatus === null || !!busy}
              onClick={() => run(blStatus ? "Desbloqueio" : "Bloqueio", () => contract.setBlacklist(blAddr, !blStatus))}>
              {blStatus ? "Desbloquear" : "Bloquear"}
            </button>
          </div>
        )}
        {roles.admin && (
          <div className="sub-card">
            <h3>Taxa por transferência</h3>
            <input type="number" min="0" max="5" step="0.01" placeholder={`Atual: ${(data.feeBps / 100).toFixed(2)}% (máx 5%)`} value={fee} onChange={(e) => setFee(e.target.value)} />
            <button className="btn btn-outline" disabled={fee === "" || Number(fee) < 0 || Number(fee) > 5 || !!busy}
              onClick={() => run("Nova taxa", () => contract.setFeeBps(Math.round(Number(fee) * 100))).then((ok) => ok && setFee(""))}>
              Atualizar taxa
            </button>
          </div>
        )}
        {roles.pauser && (
          <div className="sub-card">
            <h3>Emergência</h3>
            <p className="muted">Pausar bloqueia transferências, mint, burn e staking.</p>
            <button className={`btn ${data.paused ? "btn-green" : "btn-danger"}`} disabled={!!busy}
              onClick={() => run(data.paused ? "Despausar" : "Pausar", () => (data.paused ? contract.unpause() : contract.pause()))}>
              {data.paused ? "Retomar token" : "Pausar token"}
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Pequenos componentes
// ---------------------------------------------------------------------------
function Stat({ label, value, live }) {
  return (
    <div className="stat">
      <div className="label">{label} {live && <span className="live" />}</div>
      <div className="stat-val mono">{value}</div>
    </div>
  );
}

function Notice({ children, tone }) {
  return <div className={`notice ${tone === "danger" ? "notice-danger" : ""}`}>{children}</div>;
}

function Hero({ onConnect }) {
  return (
    <section className="hero">
      <div>
        <h2>Compre no comércio local.<br />Ganhe <em>CAJU</em>.</h2>
        <p>
          A cada compra numa loja parceira você recebe 5% de volta em CAJU, um token ERC-20 na rede Sepolia.
          Use para pagar benefícios, envie para amigos ou deixe rendendo 12% ao ano.
        </p>
        <button className="btn btn-primary btn-lg" onClick={onConnect}>Conectar MetaMask</button>
      </div>
      <ol className="steps">
        <li><b>1</b><span>Compra na loja parceira</span></li>
        <li><b>2</b><span>Loja emite cashback em CAJU</span></li>
        <li><b>3</b><span>Você transfere, faz staking ou resgata</span></li>
      </ol>
    </section>
  );
}

function CajuMark() {
  return (
    <svg width="44" height="44" viewBox="0 0 64 64" aria-hidden="true">
      <path d="M20 22c0-8 6-14 13-14s12 5 12 12c0 4-2 6-2 6H22s-2-1-2-4z" fill="#f2b33d" />
      <ellipse cx="32" cy="40" rx="20" ry="19" fill="#e8542f" />
      <ellipse cx="25" cy="34" rx="5" ry="7" fill="#ff8a5c" opacity=".55" />
      <path d="M32 9c-1-5 3-8 9-8-1 5-4 8-9 8z" fill="#1f5c3f" />
    </svg>
  );
}
