import StoreKit
import StoreKitTest
import XCTest

@MainActor
final class B3StoreKitDelayedTests: XCTestCase {
    private let productId = "uk.eugnel.ks2spelling.fullks2"
    private var session: SKTestSession!

    override func setUpWithError() throws {
        let testBundle = Bundle(for: type(of: self))
        let configurationURL = try XCTUnwrap(
            testBundle.url(forResource: "B3Sandbox", withExtension: "storekit")
        )
        session = try SKTestSession(contentsOf: configurationURL)
        session.resetToDefaultState()
        session.clearTransactions()
        session.disableDialogs = true
        session.askToBuyEnabled = true
    }

    override func tearDownWithError() throws {
        session.clearTransactions()
        session = nil
    }

    func testDelayedApproveProducesVerifiedPurchasedObservation() async throws {
        let initialOutcome = try await beginDelayedPurchase()
        XCTAssertEqual(initialOutcome, "pending")
        let staged = try pendingAskToBuyTransaction()

        try session.approveAskToBuyTransaction(identifier: staged.identifier)
        let verified = try await waitForVerifiedCurrentEntitlement()
        let finalTransaction = try XCTUnwrap(
            session.allTransactions().first { $0.identifier == staged.identifier }
        )
        let finalOutcome = finalTransaction.state == .purchased ? "purchased" : "unverified"

        XCTAssertEqual(finalOutcome, "purchased")
        XCTAssertEqual(verified.transaction.productID, productId)
        XCTAssertFalse(verified.opaqueProof.isEmpty)
        print(
            "B3_STOREKIT_OBSERVATION case=delayed-approve " +
                "productId=\(productId) initial=\(initialOutcome) " +
                "final=\(finalOutcome) verifiedProof=true"
        )
    }

    func testDelayedDeclineProducesNoPurchasedEntitlement() async throws {
        let initialOutcome = try await beginDelayedPurchase()
        XCTAssertEqual(initialOutcome, "pending")
        let staged = try pendingAskToBuyTransaction()

        try session.declineAskToBuyTransaction(identifier: staged.identifier)
        let currentEntitlement = await Transaction.currentEntitlement(for: productId)
        let finalRecord = session.allTransactions().first { $0.identifier == staged.identifier }
        let declined = finalRecord == nil ||
            finalRecord?.pendingAskToBuyConfirmation == false
        let finalOutcome = declined && currentEntitlement == nil ? "cancelled" : "unverified"

        XCTAssertEqual(finalOutcome, "cancelled")
        XCTAssertNil(currentEntitlement)
        print(
            "B3_STOREKIT_OBSERVATION case=delayed-decline " +
                "productId=\(productId) initial=\(initialOutcome) " +
                "final=\(finalOutcome) verifiedProof=false"
        )
    }

    private func beginDelayedPurchase() async throws -> String {
        let products = try await Product.products(for: [productId])
        let product = try XCTUnwrap(products.first)
        XCTAssertEqual(products.count, 1)
        XCTAssertEqual(product.id, productId)
        XCTAssertEqual(product.type, .nonConsumable)

        switch try await product.purchase() {
        case .pending:
            return "pending"
        case .success:
            return "purchased"
        case .userCancelled:
            return "cancelled"
        @unknown default:
            return "unverified"
        }
    }

    private func pendingAskToBuyTransaction() throws -> SKTestTransaction {
        let transaction = try XCTUnwrap(
            session.allTransactions().first { $0.productIdentifier == productId }
        )
        XCTAssertTrue(transaction.pendingAskToBuyConfirmation)
        return transaction
    }

    private func waitForVerifiedCurrentEntitlement() async throws -> (
        transaction: Transaction,
        opaqueProof: String
    ) {
        for _ in 0..<50 {
            if let result = await Transaction.currentEntitlement(for: productId) {
                switch result {
                case .verified(let transaction):
                    return (transaction, result.jwsRepresentation)
                case .unverified:
                    XCTFail("StoreKit Test produced an unverified current entitlement")
                    throw StoreKitTestFailure.unverified
                }
            }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        XCTFail("Timed out waiting for the approved StoreKit Test entitlement")
        throw StoreKitTestFailure.timedOut
    }
}

private enum StoreKitTestFailure: Error {
    case timedOut
    case unverified
}
