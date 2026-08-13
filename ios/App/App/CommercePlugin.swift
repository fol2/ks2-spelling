import Capacitor
import Foundation
import StoreKit

// Product identity is shape-checked here; the exact allowlist is the store
// product catalogue (config/store-products.json read through listStoreProducts()),
// enforced in the application layer, and the store only sells configured products.
private let maxProductIdentityLength = 128
private let maxRequestedProductIds = 16

private func isLowerAlphanumericScalar(_ scalar: Unicode.Scalar) -> Bool {
    ("a"..."z").contains(scalar) || ("0"..."9").contains(scalar)
}

// Mirrors the domain contract APPLE_PRODUCT_ID: dot-joined lower-alphanumeric
// segments, at least two of them.
private func isAppleProductIdentity(_ value: String) -> Bool {
    guard !value.isEmpty, value.count <= maxProductIdentityLength else { return false }
    let segments = value.split(separator: ".", omittingEmptySubsequences: false)
    guard segments.count >= 2 else { return false }
    return segments.allSatisfy { segment in
        !segment.isEmpty && segment.unicodeScalars.allSatisfy(isLowerAlphanumericScalar)
    }
}

// Mirrors the domain contract GOOGLE_PRODUCT_ID: a leading letter, then
// underscore-joined lower-alphanumeric segments. Never contains a dot, so the
// Apple and Google identity shapes are disjoint.
private func isGoogleProductIdentity(_ value: String) -> Bool {
    guard let first = value.unicodeScalars.first, ("a"..."z").contains(first),
          value.count <= maxProductIdentityLength else { return false }
    let segments = value.split(separator: "_", omittingEmptySubsequences: false)
    return segments.allSatisfy { segment in
        !segment.isEmpty && segment.unicodeScalars.allSatisfy(isLowerAlphanumericScalar)
    }
}

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
        let requested = Set(appleProductIds)
        let products = try await Product.products(for: appleProductIds)
        guard products.count <= appleProductIds.count else { throw CommerceBridgeError.rejected }
        return try products.map { product in
            guard requested.contains(product.id),
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
        guard isAppleProductIdentity(productId) else { throw CommerceBridgeError.rejected }
        let products = try await Product.products(for: [productId])
        guard products.count == 1,
              let product = products.first,
              product.id == productId,
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
                return transientObservation(productId: productId, outcome: "pending")
            case .userCancelled:
                return transientObservation(productId: productId, outcome: "cancelled")
            @unknown default:
                throw CommerceBridgeError.rejected
            }
        } catch is CancellationError {
            return transientObservation(productId: productId, outcome: "cancelled")
        } catch StoreKitError.userCancelled {
            return transientObservation(productId: productId, outcome: "cancelled")
        } catch {
            throw CommerceBridgeError.rejected
        }
    }

    func queryTransactions(productIds: [String]) async throws -> [CommerceObservation] {
        let appleProductIds = try requestedAppleProductIds(productIds)
        guard !appleProductIds.isEmpty else { return [] }
        return await collectTransactions(
            allowedProductIds: Set(appleProductIds),
            includeUnfinished: true
        )
    }

    func restore(productIds: [String]) async throws -> [CommerceObservation] {
        let appleProductIds = try requestedAppleProductIds(productIds)
        guard !appleProductIds.isEmpty else { return [] }
        do {
            try await AppStore.sync()
        } catch {
            throw CommerceBridgeError.rejected
        }
        return await collectTransactions(
            allowedProductIds: Set(appleProductIds),
            includeUnfinished: false
        )
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
                      isAppleProductIdentity(candidate.productID) else {
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
        await collectTransactions(allowedProductIds: nil, includeUnfinished: true)
    }

    // allowedProductIds nil means every shape-valid product: the launch replay
    // has no request to bound it, while explicit queries pin their request set.
    private func collectTransactions(
        allowedProductIds: Set<String>?,
        includeUnfinished: Bool
    ) async -> [CommerceObservation] {
        var observations: [String: CommerceObservation] = [:]
        func admit(_ result: VerificationResult<Transaction>) {
            guard let observation = normalise(result),
                  allowedProductIds?.contains(observation.productId) ?? true else { return }
            observations[observation.transactionRef] = observation
        }
        if includeUnfinished {
            for await result in Transaction.unfinished {
                admit(result)
            }
        }
        for await result in Transaction.currentEntitlements {
            admit(result)
        }
        for observation in await latestRevokedObservations(allowedProductIds: allowedProductIds) {
            observations[observation.transactionRef] = observation
        }
        return observations.values.sorted { $0.transactionRef < $1.transactionRef }
    }

    // Revoked products vanish from currentEntitlements, so the candidates for a
    // latest-revoked probe come from the full transaction history instead of a
    // hard-coded product list.
    private func latestRevokedObservations(
        allowedProductIds: Set<String>?
    ) async -> [CommerceObservation] {
        var candidateProductIds = Set<String>()
        for await result in Transaction.all {
            switch result {
            case .verified(let transaction):
                candidateProductIds.insert(transaction.productID)
            case .unverified(let transaction, _):
                candidateProductIds.insert(transaction.productID)
            }
        }
        var observations: [CommerceObservation] = []
        for productId in candidateProductIds.sorted() {
            guard isAppleProductIdentity(productId),
                  allowedProductIds?.contains(productId) ?? true,
                  let result = await Transaction.latest(for: productId),
                  let observation = normalise(result),
                  observation.outcome == "revoked" else { continue }
            observations.append(observation)
        }
        return observations
    }

    private func normalise(
        _ result: VerificationResult<Transaction>
    ) -> CommerceObservation? {
        switch result {
        case .verified(let transaction):
            guard isAppleProductIdentity(transaction.productID) else { return nil }
            let transactionRef = reference(for: transaction)
            verifiedTransactions[transactionRef] = transaction
            return CommerceObservation(
                productId: transaction.productID,
                outcome: transaction.revocationDate == nil ? "purchased" : "revoked",
                transactionRef: transactionRef,
                opaqueProof: result.jwsRepresentation
            )
        case .unverified(let transaction, _):
            guard isAppleProductIdentity(transaction.productID) else { return nil }
            return CommerceObservation(
                productId: transaction.productID,
                outcome: "unverified",
                transactionRef: reference(for: transaction),
                opaqueProof: nil
            )
        }
    }

    private func transientObservation(productId: String, outcome: String) -> CommerceObservation {
        CommerceObservation(
            productId: productId,
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

    private func requestedAppleProductIds(_ productIds: [String]) throws -> [String] {
        guard !productIds.isEmpty,
              productIds.count <= maxRequestedProductIds,
              Set(productIds).count == productIds.count,
              productIds.allSatisfy({ candidate in
                  isAppleProductIdentity(candidate) || isGoogleProductIdentity(candidate)
              }) else {
            throw CommerceBridgeError.rejected
        }
        return productIds.filter(isAppleProductIdentity)
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
