// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { PrismSealRegistry } from "../src/PrismSealRegistry.sol";

contract RegistryCaller {
    function anchor(PrismSealRegistry registry, bytes32 digest) external {
        registry.anchorSeal(digest);
    }

    function acceptOwnership(PrismSealRegistry registry) external {
        registry.acceptOwnership();
    }
}

contract PrismSealRegistryTest {
    PrismSealRegistry private registry;
    RegistryCaller private caller;

    function setUp() public {
        registry = new PrismSealRegistry(address(this), address(this));
        caller = new RegistryCaller();
    }

    function testAuthorizedIssuerAnchorsOnce() public {
        bytes32 digest = keccak256("decision-1");
        registry.anchorSeal(digest);

        (address issuer, uint64 anchoredAt) = registry.anchors(digest);
        require(issuer == address(this), "wrong issuer");
        require(anchoredAt != 0, "missing timestamp");
        require(registry.isAnchored(digest), "seal not anchored");

        (bool success,) =
            address(registry).call(abi.encodeCall(PrismSealRegistry.anchorSeal, (digest)));
        require(!success, "duplicate seal accepted");
    }

    function testUnauthorizedIssuerCannotAnchor() public {
        (bool success,) = address(caller)
            .call(abi.encodeCall(RegistryCaller.anchor, (registry, keccak256("unauthorized"))));
        require(!success, "unauthorized issuer accepted");
    }

    function testOwnerCanAuthorizeIssuer() public {
        bytes32 digest = keccak256("delegated");
        registry.setIssuerAuthorization(address(caller), true);
        caller.anchor(registry, digest);

        (address issuer,) = registry.anchors(digest);
        require(issuer == address(caller), "delegated issuer not recorded");
    }

    function testOwnershipTransferRequiresAcceptance() public {
        registry.beginOwnershipTransfer(address(caller));
        require(registry.owner() == address(this), "ownership transferred early");

        caller.acceptOwnership(registry);
        require(registry.owner() == address(caller), "ownership not accepted");
        require(registry.pendingOwner() == address(0), "pending owner not cleared");
    }
}
