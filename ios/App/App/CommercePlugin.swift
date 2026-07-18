import Capacitor
import Foundation
import StoreKit

private let b3AppleProductId = "uk.eugnel.ks2spelling.fullks2"
private let b3GoogleProductId = "full_ks2"
private let b3ApprovedProductIds = Set([b3AppleProductId, b3GoogleProductId])

private struct CommerceProduct: Sendable {
    let productId: String
    let displayName: String
    let description: String
    let displayPrice: String
    let currencyCode: String

    var javascriptObject: [String: Any] {
        [
            "productId": productId,
            "displayName": displayName,
            "description": description,
            "displayPrice": displayPrice,
            "currencyCode": currencyCode
        ]
    }
}

private struct CommerceObservation: Sendable {
    let productId: String
    let outcome: String
    let transactionRef: String
    let opaqueProof: String?

    var javascriptObject: [String: Any] {
        var value: [String: Any] = [
            "store": "apple",
            "environment": "sandbox",
            "productId": productId,
            "outcome": outcome,
            "transactionRef": transactionRef
        ]
        if let opaqueProof {
            value["opaqueProof"] = opaqueProof
        }
        return value
    }
}

private enum CommerceBridgeError: Error {
    case rejected

    var safeCode: String { "STORE_NATIVE_FAILURE" }
}

private actor CommerceStoreKitRuntime {
    private var verifiedTransactions: [String: Transaction] = [:]
    private var finishingTransactions = Set<String>()
    private var updatesTask: Task<Void, Never>?

    deinit {
        updatesTask?.cancel()
    }

    func start(
        observer: @escaping @Sendable (CommerceObservation) async -> Void
    ) {
        guard updatesTask == nil else { return }
        updatesTask = Task {
            for observation in await launchReplay() {
                guard !Task.isCancelled else { return }
                await observer(observation)
            }
            for await result in Transaction.updates {
                guard !Task.isCancelled else { return }
                guard let observation = normalise(result) else { continue }
                await observer(observation)
            }
        }
    }

    func queryProducts(productIds: [String]) async throws -> [CommerceProduct] {
        let appleProductIds = try requestedAppleProductIds(productIds)
        guard !appleProductIds.isEmpty else { return [] }
        let products = try await Product.products(for: appleProductIds)
        guard products.count <= 1 else { throw CommerceBridgeError.rejected }
        return try products.map { product in
            guard product.id == b3AppleProductId,
                  product.type == .nonConsumable else {
                throw CommerceBridgeError.rejected
            }
            let currencyCode = product.priceFormatStyle.currencyCode.uppercased()
            guard currencyCode.count == 3 else { throw CommerceBridgeError.rejected }
            return CommerceProduct(
                productId: product.id,
                displayName: product.displayName,
                description: product.description,
                displayPrice: product.displayPrice,
                currencyCode: currencyCode
            )
        }
    }

    func purchase(productId: String) async throws -> CommerceObservation {
        try requireExactProductId(productId)
        let products = try await Product.products(for: [b3AppleProductId])
        guard products.count == 1,
              let product = products.first,
              product.id == b3AppleProductId,
              product.type == .nonConsumable else {
            throw CommerceBridgeError.rejected
        }
        do {
            switch try await product.purchase() {
            case .success(let result):
                guard let observation = normalise(result) else {
                    throw CommerceBridgeError.rejected
                }
                return observation
            case .pending:
                return transientObservation(outcome: "pending")
            case .userCancelled:
                return transientObservation(outcome: "cancelled")
            @unknown default:
                throw CommerceBridgeError.rejected
            }
        } catch is CancellationError {
            return transientObservation(outcome: "cancelled")
        } catch StoreKitError.userCancelled {
            return transientObservation(outcome: "cancelled")
        } catch {
            throw CommerceBridgeError.rejected
        }
    }

    func queryTransactions(productIds: [String]) async throws -> [CommerceObservation] {
        let appleProductIds = try requestedAppleProductIds(productIds)
        guard !appleProductIds.isEmpty else { return [] }
        return await collectTransactions(includeUnfinished: true, includeLatest: true)
    }

    func restore(productIds: [String]) async throws -> [CommerceObservation] {
        let appleProductIds = try requestedAppleProductIds(productIds)
        guard !appleProductIds.isEmpty else { return [] }
        do {
            try await AppStore.sync()
        } catch {
            throw CommerceBridgeError.rejected
        }
        return await collectCurrentEntitlements(includeLatest: true)
    }

    func finishTransaction(transactionRef: String) async -> Bool {
        guard isValidTransactionRef(transactionRef),
              !finishingTransactions.contains(transactionRef) else {
            return false
        }

        var transaction = verifiedTransactions[transactionRef]
        if transaction == nil {
            for await result in Transaction.unfinished {
                guard case .verified(let candidate) = result,
                      candidate.productID == b3AppleProductId else {
                    continue
                }
                let candidateRef = reference(for: candidate)
                verifiedTransactions[candidateRef] = candidate
                if candidateRef == transactionRef {
                    transaction = candidate
                    break
                }
            }
        }
        guard let transaction else { return false }

        finishingTransactions.insert(transactionRef)
        await transaction.finish()
        verifiedTransactions.removeValue(forKey: transactionRef)
        finishingTransactions.remove(transactionRef)
        return true
    }

    private func launchReplay() async -> [CommerceObservation] {
        await collectTransactions(includeUnfinished: true, includeLatest: true)
    }

    private func collectTransactions(
        includeUnfinished: Bool,
        includeLatest: Bool
    ) async -> [CommerceObservation] {
        var observations: [String: CommerceObservation] = [:]
        if includeUnfinished {
            for await result in Transaction.unfinished {
                if let observation = normalise(result) {
                    observations[observation.transactionRef] = observation
                }
            }
        }
        for await result in Transaction.currentEntitlements {
            if let observation = normalise(result) {
                observations[observation.transactionRef] = observation
            }
        }
        if includeLatest,
           let result = await Transaction.latest(for: b3AppleProductId),
           let observation = normalise(result),
           observation.outcome == "revoked" {
            observations[observation.transactionRef] = observation
        }
        return observations.values.sorted { $0.transactionRef < $1.transactionRef }
    }

    private func collectCurrentEntitlements(
        includeLatest: Bool
    ) async -> [CommerceObservation] {
        var observations: [String: CommerceObservation] = [:]
        for await result in Transaction.currentEntitlements {
            if let observation = normalise(result) {
                observations[observation.transactionRef] = observation
            }
        }
        if includeLatest,
           let result = await Transaction.latest(for: b3AppleProductId),
           let observation = normalise(result),
           observation.outcome == "revoked" {
            observations[observation.transactionRef] = observation
        }
        return observations.values.sorted { $0.transactionRef < $1.transactionRef }
    }

    private func normalise(
        _ result: VerificationResult<Transaction>
    ) -> CommerceObservation? {
        switch result {
        case .verified(let transaction):
            guard transaction.productID == b3AppleProductId else { return nil }
            let transactionRef = reference(for: transaction)
            verifiedTransactions[transactionRef] = transaction
            return CommerceObservation(
                productId: transaction.productID,
                outcome: transaction.revocationDate == nil ? "purchased" : "revoked",
                transactionRef: transactionRef,
                opaqueProof: result.jwsRepresentation
            )
        case .unverified(let transaction, _):
            guard transaction.productID == b3AppleProductId else { return nil }
            return CommerceObservation(
                productId: transaction.productID,
                outcome: "unverified",
                transactionRef: reference(for: transaction),
                opaqueProof: nil
            )
        }
    }

    private func transientObservation(outcome: String) -> CommerceObservation {
        CommerceObservation(
            productId: b3AppleProductId,
            outcome: outcome,
            transactionRef: "apple-sk2-transient-\(UUID().uuidString.lowercased())",
            opaqueProof: nil
        )
    }

    private func reference(for transaction: Transaction) -> String {
        "apple-sk2-transaction-\(transaction.id)"
    }

    private func isValidTransactionRef(_ value: String) -> Bool {
        let prefix = "apple-sk2-transaction-"
        guard value.hasPrefix(prefix), value.count <= 64 else { return false }
        return value.dropFirst(prefix.count).allSatisfy(\.isNumber)
    }

    private func requireExactProductId(_ productId: String) throws {
        guard productId == b3AppleProductId else { throw CommerceBridgeError.rejected }
    }

    private func requestedAppleProductIds(_ productIds: [String]) throws -> [String] {
        guard !productIds.isEmpty,
              productIds.count <= b3ApprovedProductIds.count,
              Set(productIds).count == productIds.count,
              productIds.allSatisfy(b3ApprovedProductIds.contains) else {
            throw CommerceBridgeError.rejected
        }
        return productIds.contains(b3AppleProductId) ? [b3AppleProductId] : []
    }
}

private final class CommerceObservationEmitter: @unchecked Sendable {
    private weak var plugin: CommercePlugin?

    init(plugin: CommercePlugin) {
        self.plugin = plugin
    }

    @MainActor
    func emit(_ observation: CommerceObservation) {
        plugin?.notifyListeners(
            "transactionUpdated",
            data: observation.javascriptObject
        )
    }
}

@objc(CommercePlugin)
public final class CommercePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "CommercePlugin"
    public let jsName = "Commerce"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "queryProducts", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "purchase", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "queryTransactions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "restore", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "finishTransaction", returnType: CAPPluginReturnPromise)
    ]

    private let storeKit = CommerceStoreKitRuntime()

    public override func load() {
        let emitter = CommerceObservationEmitter(plugin: self)
        Task { [storeKit, emitter] in
            await storeKit.start { observation in
                await emitter.emit(observation)
            }
        }
    }

    @objc public func queryProducts(_ call: CAPPluginCall) {
        Task {
            do {
                try requireKeys(call, exactly: ["productIds"])
                guard let productIds = call.getArray("productIds", String.self) else {
                    throw CommerceBridgeError.rejected
                }
                let products = try await storeKit.queryProducts(productIds: productIds)
                call.resolve(["products": products.map(\.javascriptObject)])
            } catch {
                reject(call)
            }
        }
    }

    @objc public func purchase(_ call: CAPPluginCall) {
        Task {
            do {
                try requireKeys(call, exactly: ["productId"])
                guard let productId = call.getString("productId") else {
                    throw CommerceBridgeError.rejected
                }
                let observation = try await storeKit.purchase(productId: productId)
                call.resolve(observation.javascriptObject)
            } catch {
                reject(call)
            }
        }
    }

    @objc public func queryTransactions(_ call: CAPPluginCall) {
        Task {
            do {
                try requireKeys(call, exactly: ["productIds"])
                guard let productIds = call.getArray("productIds", String.self) else {
                    throw CommerceBridgeError.rejected
                }
                let transactions = try await storeKit.queryTransactions(productIds: productIds)
                call.resolve(["transactions": transactions.map(\.javascriptObject)])
            } catch {
                reject(call)
            }
        }
    }

    @objc public func restore(_ call: CAPPluginCall) {
        Task {
            do {
                try requireKeys(call, exactly: ["productIds"])
                guard let productIds = call.getArray("productIds", String.self) else {
                    throw CommerceBridgeError.rejected
                }
                let transactions = try await storeKit.restore(productIds: productIds)
                call.resolve(["transactions": transactions.map(\.javascriptObject)])
            } catch {
                reject(call)
            }
        }
    }

    @objc public func finishTransaction(_ call: CAPPluginCall) {
        Task {
            do {
                try requireKeys(call, exactly: ["transactionRef"])
                guard let transactionRef = call.getString("transactionRef") else {
                    throw CommerceBridgeError.rejected
                }
                let finished = await storeKit.finishTransaction(transactionRef: transactionRef)
                call.resolve(["completion": finished ? "finished" : "pending"])
            } catch {
                reject(call)
            }
        }
    }

    private func requireKeys(_ call: CAPPluginCall, exactly expected: Set<String>) throws {
        let keys = Set(call.options.keys.compactMap { $0 as? String })
        guard keys == expected, call.options.keys.count == keys.count else {
            throw CommerceBridgeError.rejected
        }
    }

    private func reject(_ call: CAPPluginCall) {
        call.reject("Store operation rejected.", CommerceBridgeError.rejected.safeCode)
    }
}
