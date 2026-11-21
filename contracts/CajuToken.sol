// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {ERC20Pausable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Pausable.sol";
import {ERC20Capped} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Capped.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title  CajuToken (CAJU)
 * @notice Token de cashback para o comércio local do Piauí.
 *         Lojas parceiras emitem CAJU ao cliente a cada compra; o cliente
 *         pode transferir, fazer staking para render mais CAJU ou resgatar
 *         (queimar) os tokens em troca de benefícios nas lojas.
 *
 *         Referência de valor: 1 CAJU = R$ 1,00 em benefícios.
 *
 * Funcionalidades extras implementadas (a prova pede no mínimo 2):
 *   1. Mint ............ lojas parceiras (MINTER_ROLE) emitem cashback
 *   2. Burn ............ resgate de benefícios queima os tokens
 *   3. Taxa ............ % por transferência enviada à tesouraria
 *   4. Blacklist ....... bloqueio de carteiras fraudulentas
 *   5. Pause ........... pausa de emergência de todo o token
 *   6. Staking simples . rendimento anual fixo pago em CAJU
 */
contract CajuToken is ERC20, ERC20Burnable, ERC20Pausable, ERC20Capped, AccessControl, ReentrancyGuard {
    // ------------------------------------------------------------------
    // Papéis (controle de acesso)
    // ------------------------------------------------------------------
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");         // lojas parceiras
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");         // emergência
    bytes32 public constant COMPLIANCE_ROLE = keccak256("COMPLIANCE_ROLE"); // blacklist

    // ------------------------------------------------------------------
    // Tokenomics
    // ------------------------------------------------------------------
    uint256 public constant MAX_SUPPLY = 10_000_000 * 1e18;      // teto absoluto
    uint256 public constant INITIAL_SUPPLY = 2_000_000 * 1e18;   // emitido no deploy
    uint16 public constant MAX_FEE_BPS = 500;                    // taxa máx. 5%
    uint16 public constant MAX_CASHBACK_BPS = 2_000;             // cashback máx. 20%
    uint16 public constant STAKING_APR_BPS = 1_200;              // staking rende 12% a.a.
    uint256 private constant BPS = 10_000;
    uint256 private constant YEAR = 365 days;
    uint256 private constant UNITS_PER_CENT = 1e16;              // 1 centavo = 0,01 CAJU

    // treasury (20 bytes) + feeBps (2) + cashbackBps (2) cabem em 1 slot -> menos gas
    address public treasury;
    uint16 public feeBps = 100;       // 1% por transferência
    uint16 public cashbackBps = 500;  // 5% do valor da compra

    // ------------------------------------------------------------------
    // Estado
    // ------------------------------------------------------------------
    mapping(address => bool) public isBlacklisted;
    mapping(address => bool) public isFeeExempt;

    struct StakeInfo {
        uint256 amount;        // CAJU travado
        uint256 rewardAccrued; // rendimento acumulado ainda não sacado
        uint64 lastUpdate;     // último cálculo de rendimento
    }

    mapping(address => StakeInfo) public stakes;
    uint256 public totalStaked;

    // ------------------------------------------------------------------
    // Eventos
    // ------------------------------------------------------------------
    event CashbackConcedido(address indexed loja, address indexed cliente, uint256 valorCompraCentavos, uint256 tokens);
    event BeneficioResgatado(address indexed cliente, uint256 tokens, string beneficio);
    event TaxaCobrada(address indexed from, address indexed treasury, uint256 valor);
    event BlacklistAtualizada(address indexed conta, bool bloqueada);
    event IsencaoAtualizada(address indexed conta, bool isenta);
    event TaxaAlterada(uint16 novaTaxaBps);
    event CashbackAlterado(uint16 novoCashbackBps);
    event TesourariaAlterada(address indexed novaTesouraria);
    event Staked(address indexed conta, uint256 valor);
    event Unstaked(address indexed conta, uint256 valor);
    event RendimentoSacado(address indexed conta, uint256 valor);

    // ------------------------------------------------------------------
    // Constructor
    // ------------------------------------------------------------------
    constructor(address treasury_) ERC20("Caju Cashback", "CAJU") ERC20Capped(MAX_SUPPLY) {
        require(treasury_ != address(0), "CAJU: tesouraria invalida");
        treasury = treasury_;

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(MINTER_ROLE, msg.sender);
        _grantRole(PAUSER_ROLE, msg.sender);
        _grantRole(COMPLIANCE_ROLE, msg.sender);

        isFeeExempt[msg.sender] = true;
        isFeeExempt[treasury_] = true;
        isFeeExempt[address(this)] = true; // staking não paga taxa

        // Distribuição inicial: 70% fundo de cashback/operação, 30% tesouraria
        _mint(msg.sender, (INITIAL_SUPPLY * 70) / 100);
        _mint(treasury_, (INITIAL_SUPPLY * 30) / 100);
    }

    // ------------------------------------------------------------------
    // 1. Mint / Cashback (lojas parceiras)
    // ------------------------------------------------------------------
    /// @notice Loja registra uma compra e o cliente recebe cashback em CAJU.
    function darCashback(address cliente, uint256 valorCompraCentavos)
        external
        onlyRole(MINTER_ROLE)
        returns (uint256 tokens)
    {
        require(cliente != address(0), "CAJU: cliente invalido");
        require(valorCompraCentavos > 0, "CAJU: compra sem valor");
        tokens = (valorCompraCentavos * UNITS_PER_CENT * cashbackBps) / BPS;
        require(tokens > 0, "CAJU: cashback zero");
        _mint(cliente, tokens);
        emit CashbackConcedido(msg.sender, cliente, valorCompraCentavos, tokens);
    }

    /// @notice Emissão direta (campanhas, premiações).
    function mint(address to, uint256 amount) external onlyRole(MINTER_ROLE) {
        require(to != address(0), "CAJU: destino invalido");
        require(amount > 0, "CAJU: valor zero");
        _mint(to, amount);
    }

    // ------------------------------------------------------------------
    // 2. Burn / Resgate de benefícios
    // ------------------------------------------------------------------
    /// @notice Cliente queima CAJU para resgatar um benefício (ex.: "Desconto loja X").
    function resgatar(uint256 amount, string calldata beneficio) external {
        require(amount > 0, "CAJU: valor zero");
        require(bytes(beneficio).length > 0, "CAJU: informe o beneficio");
        _burn(msg.sender, amount);
        emit BeneficioResgatado(msg.sender, amount, beneficio);
    }

    // ------------------------------------------------------------------
    // 3. Taxa por transferência
    // ------------------------------------------------------------------
    function setFeeBps(uint16 novaTaxa) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(novaTaxa <= MAX_FEE_BPS, "CAJU: taxa acima do limite");
        feeBps = novaTaxa;
        emit TaxaAlterada(novaTaxa);
    }

    function setFeeExempt(address conta, bool isenta) external onlyRole(DEFAULT_ADMIN_ROLE) {
        isFeeExempt[conta] = isenta;
        emit IsencaoAtualizada(conta, isenta);
    }

    function setTreasury(address nova) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(nova != address(0), "CAJU: tesouraria invalida");
        treasury = nova;
        isFeeExempt[nova] = true;
        emit TesourariaAlterada(nova);
    }

    function setCashbackBps(uint16 novo) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(novo > 0 && novo <= MAX_CASHBACK_BPS, "CAJU: cashback fora do limite");
        cashbackBps = novo;
        emit CashbackAlterado(novo);
    }

    /// @notice Quanto o destinatário recebe de fato numa transferência de `amount`.
    function previewTransfer(address from, address to, uint256 amount)
        external
        view
        returns (uint256 liquido, uint256 taxa)
    {
        taxa = _feeFor(from, to, amount);
        liquido = amount - taxa;
    }

    // ------------------------------------------------------------------
    // 4. Blacklist
    // ------------------------------------------------------------------
    function setBlacklist(address conta, bool bloqueada) external onlyRole(COMPLIANCE_ROLE) {
        require(conta != address(0), "CAJU: conta invalida");
        require(!hasRole(DEFAULT_ADMIN_ROLE, conta), "CAJU: admin nao pode ser bloqueado");
        isBlacklisted[conta] = bloqueada;
        emit BlacklistAtualizada(conta, bloqueada);
    }

    // ------------------------------------------------------------------
    // 5. Pause
    // ------------------------------------------------------------------
    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    // ------------------------------------------------------------------
    // 6. Staking simples (12% a.a., rendimento linear por segundo)
    // ------------------------------------------------------------------
    modifier atualizaRendimento(address conta) {
        StakeInfo storage s = stakes[conta];
        s.rewardAccrued = earned(conta);
        s.lastUpdate = uint64(block.timestamp);
        _;
    }

    function earned(address conta) public view returns (uint256) {
        StakeInfo storage s = stakes[conta];
        if (s.amount == 0) return s.rewardAccrued;
        uint256 elapsed = block.timestamp - s.lastUpdate;
        return s.rewardAccrued + (s.amount * STAKING_APR_BPS * elapsed) / (BPS * YEAR);
    }

    function stake(uint256 amount) external nonReentrant atualizaRendimento(msg.sender) {
        require(amount > 0, "CAJU: valor zero");
        _transfer(msg.sender, address(this), amount);
        stakes[msg.sender].amount += amount;
        totalStaked += amount;
        emit Staked(msg.sender, amount);
    }

    function unstake(uint256 amount) external nonReentrant atualizaRendimento(msg.sender) {
        StakeInfo storage s = stakes[msg.sender];
        require(amount > 0, "CAJU: valor zero");
        require(amount <= s.amount, "CAJU: stake insuficiente");
        s.amount -= amount;
        totalStaked -= amount;
        _transfer(address(this), msg.sender, amount);
        emit Unstaked(msg.sender, amount);
    }

    function claimRewards() external nonReentrant atualizaRendimento(msg.sender) {
        StakeInfo storage s = stakes[msg.sender];
        uint256 reward = s.rewardAccrued;
        require(reward > 0, "CAJU: sem rendimento");
        uint256 espaco = cap() - totalSupply();
        if (reward > espaco) reward = espaco; // nunca ultrapassa o teto
        require(reward > 0, "CAJU: teto de emissao atingido");
        s.rewardAccrued -= reward;
        _mint(msg.sender, reward);
        emit RendimentoSacado(msg.sender, reward);
    }

    // ------------------------------------------------------------------
    // Núcleo: todas as movimentações passam por aqui
    // ------------------------------------------------------------------
    function _feeFor(address from, address to, uint256 amount) internal view returns (uint256) {
        if (from == address(0) || to == address(0)) return 0; // mint/burn
        if (feeBps == 0 || isFeeExempt[from] || isFeeExempt[to]) return 0;
        return (amount * feeBps) / BPS;
    }

    function _update(address from, address to, uint256 value)
        internal
        override(ERC20, ERC20Pausable, ERC20Capped)
    {
        require(!isBlacklisted[from] && !isBlacklisted[to], "CAJU: endereco bloqueado");

        uint256 taxa = _feeFor(from, to, value);
        if (taxa > 0) {
            super._update(from, treasury, taxa);
            emit TaxaCobrada(from, treasury, taxa);
            value -= taxa;
        }
        super._update(from, to, value);
    }
}
