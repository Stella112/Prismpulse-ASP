// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title PrismSealRegistry
/// @notice Anchors PrismPulse decision digests without publishing underlying evidence.
contract PrismSealRegistry {
    struct SealAnchor {
        address issuer;
        uint64 anchoredAt;
    }

    error NotOwner();
    error NotPendingOwner();
    error UnauthorizedIssuer();
    error InvalidAddress();
    error InvalidDigest();
    error SealAlreadyAnchored();

    event SealAnchored(bytes32 indexed decisionDigest, address indexed issuer, uint64 anchoredAt);
    event IssuerAuthorizationSet(address indexed issuer, bool authorized);
    event OwnershipTransferStarted(address indexed currentOwner, address indexed pendingOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    address public owner;
    address public pendingOwner;
    mapping(address issuer => bool authorized) public authorizedIssuers;
    mapping(bytes32 decisionDigest => SealAnchor anchor) public anchors;

    constructor(address initialOwner, address initialIssuer) {
        if (initialOwner == address(0) || initialIssuer == address(0)) revert InvalidAddress();
        owner = initialOwner;
        authorizedIssuers[initialIssuer] = true;
        emit OwnershipTransferred(address(0), initialOwner);
        emit IssuerAuthorizationSet(initialIssuer, true);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    function setIssuerAuthorization(address issuer, bool authorized) external onlyOwner {
        if (issuer == address(0)) revert InvalidAddress();
        authorizedIssuers[issuer] = authorized;
        emit IssuerAuthorizationSet(issuer, authorized);
    }

    function beginOwnershipTransfer(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert InvalidAddress();
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner();
        address previousOwner = owner;
        owner = msg.sender;
        pendingOwner = address(0);
        emit OwnershipTransferred(previousOwner, msg.sender);
    }

    function anchorSeal(bytes32 decisionDigest) external {
        if (!authorizedIssuers[msg.sender]) revert UnauthorizedIssuer();
        if (decisionDigest == bytes32(0)) revert InvalidDigest();
        if (anchors[decisionDigest].anchoredAt != 0) revert SealAlreadyAnchored();

        uint64 anchoredAt = uint64(block.timestamp);
        anchors[decisionDigest] = SealAnchor({ issuer: msg.sender, anchoredAt: anchoredAt });
        emit SealAnchored(decisionDigest, msg.sender, anchoredAt);
    }

    function isAnchored(bytes32 decisionDigest) external view returns (bool) {
        return anchors[decisionDigest].anchoredAt != 0;
    }
}
