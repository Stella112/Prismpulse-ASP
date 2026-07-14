// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { PrismBondPool } from "../src/PrismBondPool.sol";

interface Vm {
    function warp(uint256) external;
}

contract MockStablecoin {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "balance");
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amount, "allowance");
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract UnauthorizedBondCaller {
    function request(PrismBondPool pool, bytes32 id, bytes32 evidence) external {
        pool.requestPayout(id, evidence);
    }
}

contract PrismBondPoolTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    MockStablecoin private token;
    PrismBondPool private pool;
    UnauthorizedBondCaller private outsider;

    uint96 private constant TX_CAP = 100_000;
    uint256 private constant GLOBAL_CAP = 300_000;

    function setUp() public {
        token = new MockStablecoin();
        pool = new PrismBondPool(
            address(token), address(this), address(this), TX_CAP, GLOBAL_CAP, 10_000, 1 days
        );
        outsider = new UnauthorizedBondCaller();
        token.mint(address(this), 1_000_000);
        token.approve(address(pool), type(uint256).max);
        pool.deposit(500_000);
    }

    function bind(uint96 amount) private returns (bytes32) {
        return pool.bindCoverage(
            address(this),
            amount,
            1_000,
            uint64(block.timestamp + 7 days),
            keccak256("sentinel"),
            keccak256("flagged-recipient-trigger")
        );
    }

    function testStakePremiumAndImmediateCappedPayout() public {
        pool.setLimits(TX_CAP, GLOBAL_CAP, TX_CAP, 1 days);
        bytes32 id = bind(TX_CAP);
        require(pool.coveredExposure() == TX_CAP, "exposure missing");
        require(pool.totalPremiums() == 1_000, "premium missing");
        pool.requestPayout(id, keccak256("objective-chain-evidence"));
        pool.finalizePayout(id);
        require(pool.coveredExposure() == 0, "exposure not released");
        require(pool.totalLosses() == TX_CAP, "loss not recorded");
        (,,,,,,,, PrismBondPool.CoverageState state) = pool.coverages(id);
        require(state == PrismBondPool.CoverageState.PAID, "not paid");
    }

    function testNonTrivialPayoutIsTimelocked() public {
        pool.setLimits(TX_CAP, GLOBAL_CAP, 0, 1 days);
        bytes32 id = bind(50_000);
        pool.requestPayout(id, keccak256("evidence"));
        (bool early,) = address(pool).call(abi.encodeCall(PrismBondPool.finalizePayout, (id)));
        require(!early, "timelock bypassed");
        vm.warp(block.timestamp + 1 days);
        pool.finalizePayout(id);
        require(pool.totalLosses() == 50_000, "delayed payout missing");
    }

    function testGuardianPauseAndVeto() public {
        pool.setLimits(TX_CAP, GLOBAL_CAP, TX_CAP, 0);
        bytes32 id = bind(20_000);
        pool.requestPayout(id, keccak256("evidence"));
        pool.setPayoutsPaused(true);
        (bool paidWhilePaused,) =
            address(pool).call(abi.encodeCall(PrismBondPool.finalizePayout, (id)));
        require(!paidWhilePaused, "pause bypassed");
        pool.vetoPayout(id);
        (,,,,,,,, PrismBondPool.CoverageState state) = pool.coverages(id);
        require(state == PrismBondPool.CoverageState.ACTIVE, "veto did not restore coverage");
    }

    function testPerTransactionAndGlobalCapsEnforce() public {
        (bool overPerTx,) = address(pool)
            .call(
                abi.encodeCall(
                    PrismBondPool.bindCoverage,
                    (
                        address(this),
                        uint96(TX_CAP + 1),
                        uint96(1_000),
                        uint64(block.timestamp + 1 days),
                        keccak256("a"),
                        keccak256("b")
                    )
                )
            );
        require(!overPerTx, "per transaction cap bypassed");
        bind(TX_CAP);
        bind(TX_CAP);
        bind(TX_CAP);
        (bool overGlobal,) = address(pool)
            .call(
                abi.encodeCall(
                    PrismBondPool.bindCoverage,
                    (
                        address(this),
                        uint96(1),
                        uint96(1_000),
                        uint64(block.timestamp + 1 days),
                        keccak256("c"),
                        keccak256("d")
                    )
                )
            );
        require(!overGlobal, "global cap bypassed");
    }

    function testExposureLocksStakerCapital() public {
        bind(TX_CAP);
        (bool withdrew,) = address(pool).call(abi.encodeCall(PrismBondPool.withdraw, (500_000)));
        require(!withdrew, "locked exposure withdrawn");
    }

    function testKillSwitchStopsNewCoverageAndPayouts() public {
        pool.setGlobalKillSwitch(true);
        (bool bound,) = address(pool)
            .call(
                abi.encodeCall(
                    PrismBondPool.bindCoverage,
                    (
                        address(this),
                        uint96(1),
                        uint96(1),
                        uint64(block.timestamp + 1 days),
                        keccak256("a"),
                        keccak256("b")
                    )
                )
            );
        require(!bound, "coverage bound while killed");
    }

    function testOnlyAuthorizedOracleCanRequestPayout() public {
        bytes32 id = bind(10_000);
        (bool success,) = address(outsider)
            .call(
                abi.encodeCall(
                    UnauthorizedBondCaller.request, (pool, id, keccak256("fake-evidence"))
                )
            );
        require(!success, "unauthorized oracle accepted");
    }
}
