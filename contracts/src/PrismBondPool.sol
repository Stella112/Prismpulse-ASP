// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IERC20Minimal {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @title PrismBondPool
/// @notice Proof-of-concept underwriting rails: capped, parametric, objective-trigger micro-coverage.
/// @dev This contract is not a regulated insurance product.
contract PrismBondPool {
    enum CoverageState { NONE, ACTIVE, CLAIM_PENDING, PAID, CANCELLED }

    struct Coverage {
        address beneficiary;
        uint96 coveredAmount;
        uint96 premium;
        uint64 expiry;
        uint64 payoutEligibleAt;
        bytes32 sentinelReceiptHash;
        bytes32 triggerSpecHash;
        bytes32 claimEvidenceHash;
        CoverageState state;
    }

    error NotOwner();
    error NotPendingOwner();
    error NotGuardian();
    error NotUnderwriter();
    error NotOracle();
    error InvalidAddress();
    error InvalidAmount();
    error InvalidHash();
    error InvalidState();
    error CoverageCapExceeded();
    error InsufficientCapital();
    error ExposureLocked();
    error PayoutPaused();
    error KillSwitchActive();
    error TimelockActive();
    error TransferFailed();
    error ReentrantCall();

    event Deposited(address indexed staker, uint256 assets, uint256 shares);
    event Withdrawn(address indexed staker, uint256 assets, uint256 shares);
    event CoverageBound(bytes32 indexed coverageId, address indexed beneficiary, uint256 amount, uint256 premium, bytes32 sentinelReceiptHash);
    event PayoutRequested(bytes32 indexed coverageId, bytes32 evidenceHash, uint64 eligibleAt);
    event PayoutVetoed(bytes32 indexed coverageId, address indexed guardian);
    event PayoutFinalized(bytes32 indexed coverageId, address indexed beneficiary, uint256 amount, bytes32 evidenceHash);
    event CoverageExpired(bytes32 indexed coverageId);
    event PayoutPauseSet(bool paused);
    event KillSwitchSet(bool active);
    event GuardianSet(address indexed guardian);
    event UnderwriterAuthorizationSet(address indexed underwriter, bool authorized);
    event OracleAuthorizationSet(address indexed oracle, bool authorized);
    event LimitsSet(uint256 perTransactionCap, uint256 globalExposureCap, uint256 tinyPayoutThreshold, uint64 payoutDelay);
    event OwnershipTransferStarted(address indexed currentOwner, address indexed pendingOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    IERC20Minimal public immutable asset;
    address public owner;
    address public pendingOwner;
    address public guardian;
    bool public payoutsPaused;
    bool public globalKillSwitch;
    uint256 public perTransactionCap;
    uint256 public globalExposureCap;
    uint256 public tinyPayoutThreshold;
    uint64 public payoutDelay;
    uint256 public totalShares;
    uint256 public coveredExposure;
    uint256 public totalPremiums;
    uint256 public totalLosses;
    uint256 private nonce;
    uint256 private entered = 1;

    mapping(address => uint256) public sharesOf;
    mapping(address => bool) public authorizedUnderwriters;
    mapping(address => bool) public authorizedOracles;
    mapping(bytes32 => Coverage) public coverages;

    constructor(
        address assetAddress,
        address initialOwner,
        address initialGuardian,
        uint256 initialPerTransactionCap,
        uint256 initialGlobalExposureCap,
        uint256 initialTinyPayoutThreshold,
        uint64 initialPayoutDelay
    ) {
        if (assetAddress == address(0) || initialOwner == address(0) || initialGuardian == address(0)) revert InvalidAddress();
        if (initialPerTransactionCap == 0 || initialGlobalExposureCap < initialPerTransactionCap) revert InvalidAmount();
        asset = IERC20Minimal(assetAddress);
        owner = initialOwner;
        guardian = initialGuardian;
        authorizedUnderwriters[initialOwner] = true;
        authorizedOracles[initialOwner] = true;
        _setLimits(initialPerTransactionCap, initialGlobalExposureCap, initialTinyPayoutThreshold, initialPayoutDelay);
        emit OwnershipTransferred(address(0), initialOwner);
        emit GuardianSet(initialGuardian);
        emit UnderwriterAuthorizationSet(initialOwner, true);
        emit OracleAuthorizationSet(initialOwner, true);
    }

    modifier onlyOwner() { if (msg.sender != owner) revert NotOwner(); _; }
    modifier onlyGuardian() { if (msg.sender != guardian) revert NotGuardian(); _; }
    modifier onlyUnderwriter() { if (!authorizedUnderwriters[msg.sender]) revert NotUnderwriter(); _; }
    modifier onlyOracle() { if (!authorizedOracles[msg.sender]) revert NotOracle(); _; }
    modifier nonReentrant() { if (entered != 1) revert ReentrantCall(); entered = 2; _; entered = 1; }

    function totalCapital() public view returns (uint256) { return asset.balanceOf(address(this)); }
    function availableCapital() public view returns (uint256) {
        uint256 capital = totalCapital();
        return capital > coveredExposure ? capital - coveredExposure : 0;
    }
    function lossRatioBps() external view returns (uint256) {
        uint256 earned = totalPremiums;
        return earned == 0 ? (totalLosses == 0 ? 0 : 10_000) : totalLosses * 10_000 / earned;
    }

    function deposit(uint256 assets) external nonReentrant returns (uint256 shares) {
        if (assets == 0) revert InvalidAmount();
        uint256 capitalBefore = totalCapital();
        shares = totalShares == 0 ? assets : assets * totalShares / capitalBefore;
        if (shares == 0) revert InvalidAmount();
        _safeTransferFrom(msg.sender, address(this), assets);
        totalShares += shares;
        sharesOf[msg.sender] += shares;
        emit Deposited(msg.sender, assets, shares);
    }

    function withdraw(uint256 shares) external nonReentrant returns (uint256 assets) {
        if (shares == 0 || shares > sharesOf[msg.sender]) revert InvalidAmount();
        assets = shares * totalCapital() / totalShares;
        if (assets > availableCapital()) revert ExposureLocked();
        sharesOf[msg.sender] -= shares;
        totalShares -= shares;
        _safeTransfer(msg.sender, assets);
        emit Withdrawn(msg.sender, assets, shares);
    }

    function bindCoverage(
        address beneficiary,
        uint96 coveredAmount,
        uint96 premium,
        uint64 expiry,
        bytes32 sentinelReceiptHash,
        bytes32 triggerSpecHash
    ) external onlyUnderwriter nonReentrant returns (bytes32 coverageId) {
        if (globalKillSwitch) revert KillSwitchActive();
        if (beneficiary == address(0)) revert InvalidAddress();
        if (coveredAmount == 0 || premium == 0 || expiry <= block.timestamp) revert InvalidAmount();
        if (sentinelReceiptHash == bytes32(0) || triggerSpecHash == bytes32(0)) revert InvalidHash();
        if (coveredAmount > perTransactionCap || coveredExposure + coveredAmount > globalExposureCap) revert CoverageCapExceeded();
        _safeTransferFrom(msg.sender, address(this), premium);
        if (coveredExposure + coveredAmount > totalCapital()) revert InsufficientCapital();
        coverageId = keccak256(abi.encode(block.chainid, address(this), ++nonce, beneficiary, sentinelReceiptHash));
        coverages[coverageId] = Coverage({
            beneficiary: beneficiary,
            coveredAmount: coveredAmount,
            premium: premium,
            expiry: expiry,
            payoutEligibleAt: 0,
            sentinelReceiptHash: sentinelReceiptHash,
            triggerSpecHash: triggerSpecHash,
            claimEvidenceHash: bytes32(0),
            state: CoverageState.ACTIVE
        });
        coveredExposure += coveredAmount;
        totalPremiums += premium;
        emit CoverageBound(coverageId, beneficiary, coveredAmount, premium, sentinelReceiptHash);
    }

    function requestPayout(bytes32 coverageId, bytes32 evidenceHash) external onlyOracle {
        Coverage storage coverage = coverages[coverageId];
        if (coverage.state != CoverageState.ACTIVE || block.timestamp > coverage.expiry) revert InvalidState();
        if (evidenceHash == bytes32(0)) revert InvalidHash();
        uint64 delay = coverage.coveredAmount > tinyPayoutThreshold ? payoutDelay : 0;
        coverage.claimEvidenceHash = evidenceHash;
        coverage.payoutEligibleAt = uint64(block.timestamp) + delay;
        coverage.state = CoverageState.CLAIM_PENDING;
        emit PayoutRequested(coverageId, evidenceHash, coverage.payoutEligibleAt);
    }

    function vetoPayout(bytes32 coverageId) external onlyGuardian {
        Coverage storage coverage = coverages[coverageId];
        if (coverage.state != CoverageState.CLAIM_PENDING) revert InvalidState();
        coverage.state = CoverageState.ACTIVE;
        coverage.claimEvidenceHash = bytes32(0);
        coverage.payoutEligibleAt = 0;
        emit PayoutVetoed(coverageId, msg.sender);
    }

    function finalizePayout(bytes32 coverageId) external nonReentrant {
        if (payoutsPaused) revert PayoutPaused();
        if (globalKillSwitch) revert KillSwitchActive();
        Coverage storage coverage = coverages[coverageId];
        if (coverage.state != CoverageState.CLAIM_PENDING) revert InvalidState();
        if (block.timestamp < coverage.payoutEligibleAt) revert TimelockActive();
        coverage.state = CoverageState.PAID;
        coveredExposure -= coverage.coveredAmount;
        totalLosses += coverage.coveredAmount;
        _safeTransfer(coverage.beneficiary, coverage.coveredAmount);
        emit PayoutFinalized(coverageId, coverage.beneficiary, coverage.coveredAmount, coverage.claimEvidenceHash);
    }

    function expireCoverage(bytes32 coverageId) external {
        Coverage storage coverage = coverages[coverageId];
        if (coverage.state != CoverageState.ACTIVE || block.timestamp <= coverage.expiry) revert InvalidState();
        coverage.state = CoverageState.CANCELLED;
        coveredExposure -= coverage.coveredAmount;
        emit CoverageExpired(coverageId);
    }

    function setPayoutsPaused(bool paused) external onlyGuardian { payoutsPaused = paused; emit PayoutPauseSet(paused); }
    function setGlobalKillSwitch(bool active) external onlyOwner { globalKillSwitch = active; emit KillSwitchSet(active); }
    function setGuardian(address nextGuardian) external onlyOwner {
        if (nextGuardian == address(0)) revert InvalidAddress(); guardian = nextGuardian; emit GuardianSet(nextGuardian);
    }
    function setUnderwriterAuthorization(address underwriter, bool authorized) external onlyOwner {
        if (underwriter == address(0)) revert InvalidAddress(); authorizedUnderwriters[underwriter] = authorized; emit UnderwriterAuthorizationSet(underwriter, authorized);
    }
    function setOracleAuthorization(address oracle, bool authorized) external onlyOwner {
        if (oracle == address(0)) revert InvalidAddress(); authorizedOracles[oracle] = authorized; emit OracleAuthorizationSet(oracle, authorized);
    }
    function setLimits(uint256 txCap, uint256 exposureCap, uint256 tinyThreshold, uint64 delay) external onlyOwner {
        _setLimits(txCap, exposureCap, tinyThreshold, delay);
    }
    function _setLimits(uint256 txCap, uint256 exposureCap, uint256 tinyThreshold, uint64 delay) private {
        if (txCap == 0 || exposureCap < txCap) revert InvalidAmount();
        perTransactionCap = txCap; globalExposureCap = exposureCap; tinyPayoutThreshold = tinyThreshold; payoutDelay = delay;
        emit LimitsSet(txCap, exposureCap, tinyThreshold, delay);
    }
    function beginOwnershipTransfer(address nextOwner) external onlyOwner {
        if (nextOwner == address(0)) revert InvalidAddress(); pendingOwner = nextOwner; emit OwnershipTransferStarted(owner, nextOwner);
    }
    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner();
        address previousOwner = owner; owner = msg.sender; pendingOwner = address(0); emit OwnershipTransferred(previousOwner, msg.sender);
    }

    function _safeTransfer(address to, uint256 amount) private {
        (bool success, bytes memory data) = address(asset).call(abi.encodeCall(IERC20Minimal.transfer, (to, amount)));
        if (!success || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }
    function _safeTransferFrom(address from, address to, uint256 amount) private {
        (bool success, bytes memory data) = address(asset).call(abi.encodeCall(IERC20Minimal.transferFrom, (from, to, amount)));
        if (!success || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }
}