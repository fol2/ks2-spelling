import Capacitor
import CloudKit
import Foundation

@objc(ICloudLearningReplicaPlugin)
public final class ICloudLearningReplicaPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ICloudLearningReplicaPlugin"
    public let jsName = "ICloudLearningReplica"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "publish", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pull", returnType: CAPPluginReturnPromise),
    ]

    private static let containerIdentifier = "iCloud.uk.eugnel.ks2spelling"
    private static let zoneName = "learning-replica"
    private static let profileRecordType = "LearnerProfile"
    private static let snapshotRecordType = "LearnerSnapshot"
    private static let engineStateKey = "ks2.icloud.learning-replica.engine-state"

    private var container: CKContainer?
    private let zoneID = CKRecordZone.ID(
        zoneName: ICloudLearningReplicaPlugin.zoneName,
        ownerName: CKCurrentUserDefaultName
    )

    @objc public func getStatus(_ call: CAPPluginCall) {
        guard requireKeys(call, exactly: []) else {
            reject(call)
            return
        }
        guard let container = resolvedContainer() else {
            call.resolve([
                "available": false,
                "account": "unsupported",
                "container": Self.containerIdentifier,
            ])
            return
        }
        container.accountStatus { [weak self] status, _ in
            guard let self else { return }
            let account = self.mapAccount(status)
            call.resolve([
                "available": account == "available",
                "account": account,
                "container": Self.containerIdentifier,
            ])
        }
    }

    @objc public func publish(_ call: CAPPluginCall) {
        guard requireKeys(call, exactly: ["profiles", "snapshots"]) else {
            reject(call)
            return
        }
        let profiles = call.getArray("profiles", JSObject.self) ?? []
        let snapshots = call.getArray("snapshots", JSObject.self) ?? []
        Task {
            do {
                try await self.ensurePrivateZone()
                let records = try self.makeRecords(profiles: profiles, snapshots: snapshots)
                try await self.save(records)
                call.resolve(["accepted": records.count])
            } catch {
                self.reject(call, underlying: error)
            }
        }
    }

    @objc public func pull(_ call: CAPPluginCall) {
        guard requireKeys(call, exactly: []) else {
            reject(call)
            return
        }
        Task {
            do {
                try await self.ensurePrivateZone()
                let envelope = try await self.fetchEnvelope()
                call.resolve(envelope)
            } catch {
                self.reject(call, underlying: error)
            }
        }
    }

    private func privateDatabase() throws -> CKDatabase {
        try requireContainer().privateCloudDatabase
    }

    private func mapAccount(_ status: CKAccountStatus) -> String {
        switch status {
        case .available:
            return "available"
        case .noAccount:
            return "noAccount"
        case .restricted:
            return "restricted"
        case .couldNotDetermine:
            return "couldNotDetermine"
        case .temporarilyUnavailable:
            return "couldNotDetermine"
        @unknown default:
            return "couldNotDetermine"
        }
    }

    private func ensurePrivateZone() async throws {
        let zone = CKRecordZone(zoneID: zoneID)
        _ = try await privateDatabase().modifyRecordZones(saving: [zone], deleting: [])
        if #available(iOS 17.0, *) {
            _ = try await syncEngine()
        }
    }

    private func save(_ records: [CKRecord]) async throws {
        guard !records.isEmpty else { return }
        if #available(iOS 17.0, *) {
            let engine = try await syncEngine()
            let recordIDs = records.map(\.recordID)
            ReplicaRecordCache.shared.beginSend(recordIDs)
            ReplicaRecordCache.shared.store(records)
            engine.state.add(pendingRecordZoneChanges: records.map {
                .saveRecord($0.recordID)
            })
            try await engine.sendChanges()
            if ReplicaRecordCache.shared.consumeFailures(recordIDs) {
                throw ReplicaError.conflict
            }
            return
        }
        let result = try await privateDatabase().modifyRecords(
            saving: records,
            deleting: []
        )
        var savedRecords: [CKRecord] = []
        var failed = false
        for (recordID, saveResult) in result.saveResults {
            switch saveResult {
            case .success(let record):
                savedRecords.append(record)
            case .failure(let error):
                let cloudError = error as? CKError
                ReplicaRecordCache.shared.fail(
                    recordID,
                    serverRecord: cloudError?.serverRecord
                )
                failed = true
            }
        }
        ReplicaRecordCache.shared.store(savedRecords)
        if failed {
            throw ReplicaError.conflict
        }
    }

    private func fetchEnvelope() async throws -> [String: Any] {
        if #available(iOS 17.0, *) {
            let engine = try await syncEngine()
            try await engine.fetchChanges()
        }
        let profiles = try await queryRecords(Self.profileRecordType)
        let snapshots = try await queryRecords(Self.snapshotRecordType)
        return [
            "profiles": try profiles.map { try decodeProfile($0) },
            "snapshots": try snapshots.map { try decodeSnapshot($0) },
        ]
    }

    private func queryRecords(_ recordType: String) async throws -> [CKRecord] {
        let query = CKQuery(recordType: recordType, predicate: NSPredicate(value: true))
        if #available(iOS 15.0, *) {
            let result = try await privateDatabase().records(
                matching: query,
                inZoneWith: zoneID
            )
            let records = try result.matchResults.map { _, recordResult in
                try recordResult.get()
            }
            ReplicaRecordCache.shared.store(records)
            return records
        }
        return []
    }

    private func makeRecords(profiles: [JSObject], snapshots: [JSObject]) throws -> [CKRecord] {
        var records: [CKRecord] = []
        for profile in profiles {
            guard let learnerId = profile["learnerId"] as? String else {
                throw ReplicaError.invalid
            }
            let recordID = CKRecord.ID(recordName: learnerId, zoneID: zoneID)
            let payload = try encodeJSON(profile)
            let updatedAt = int64(profile["updatedAt"])
            if let cached = ReplicaRecordCache.shared.record(for: recordID),
               jsonString(cached["payload"], containsJSONEqualTo: profile),
               int64(cached["updatedAt"]) == updatedAt {
                continue
            }
            let record = ReplicaRecordCache.shared.record(for: recordID)
                ?? CKRecord(recordType: Self.profileRecordType, recordID: recordID)
            record["payload"] = payload
            record["updatedAt"] = updatedAt
            records.append(record)
        }
        for snapshot in snapshots {
            guard let learnerId = snapshot["learnerId"] as? String else {
                throw ReplicaError.invalid
            }
            let recordID = CKRecord.ID(
                recordName: "snapshot:\(learnerId)",
                zoneID: zoneID
            )
            let payload = snapshot["payload"]
            let updatedAt = int64((payload as? JSObject)?["revision"])
            if let cached = ReplicaRecordCache.shared.record(for: recordID),
               int64(cached["updatedAt"]) == updatedAt,
               try asset(cached["payload"], containsJSONEqualTo: payload) {
                continue
            }
            let record = ReplicaRecordCache.shared.record(for: recordID)
                ?? CKRecord(recordType: Self.snapshotRecordType, recordID: recordID)
            record["payload"] = try makeAsset(payload)
            record["updatedAt"] = updatedAt
            records.append(record)
        }
        return records
    }

    private func decodeProfile(_ record: CKRecord) throws -> [String: Any] {
        guard let payload = record["payload"] as? String,
              let data = payload.data(using: .utf8),
              let object = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            throw ReplicaError.invalid
        }
        return object
    }

    private func decodeSnapshot(_ record: CKRecord) throws -> [String: Any] {
        guard let asset = record["payload"] as? CKAsset,
              let fileURL = asset.fileURL,
              let data = try? Data(contentsOf: fileURL)
        else {
            throw ReplicaError.invalid
        }
        let payload = try JSONSerialization.jsonObject(with: data)
        let learnerId = record.recordID.recordName.replacingOccurrences(
            of: "snapshot:",
            with: ""
        )
        return [
            "learnerId": learnerId,
            "payload": payload,
        ]
    }

    private func encodeJSON(_ value: JSObject) throws -> String {
        let data = try JSONSerialization.data(withJSONObject: value, options: [])
        guard let encoded = String(data: data, encoding: .utf8) else {
            throw ReplicaError.invalid
        }
        return encoded
    }

    private func makeAsset(_ value: Any?) throws -> CKAsset {
        guard let value else { throw ReplicaError.invalid }
        let data = try JSONSerialization.data(withJSONObject: value, options: [])
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
            .appendingPathExtension("json")
        try data.write(to: url, options: .atomic)
        return CKAsset(fileURL: url)
    }

    private func asset(_ candidate: Any?, containsJSONEqualTo value: Any?) throws -> Bool {
        guard let asset = candidate as? CKAsset,
              let fileURL = asset.fileURL,
              let value,
              let data = try? Data(contentsOf: fileURL),
              let remote = try? JSONSerialization.jsonObject(
                with: data
              ) as? NSObject,
              let local = try? JSONSerialization.jsonObject(
                with: JSONSerialization.data(withJSONObject: value)
              ) as? NSObject
        else {
            return false
        }
        return remote.isEqual(local)
    }

    private func jsonString(_ candidate: Any?, containsJSONEqualTo value: Any) -> Bool {
        guard let candidate = candidate as? String,
              let data = candidate.data(using: .utf8),
              let remote = try? JSONSerialization.jsonObject(with: data) as? NSObject,
              let local = try? JSONSerialization.jsonObject(
                with: JSONSerialization.data(withJSONObject: value)
              ) as? NSObject
        else {
            return false
        }
        return remote.isEqual(local)
    }

    private func int64(_ value: Any?) -> Int64 {
        if let number = value as? NSNumber { return number.int64Value }
        if let number = value as? Int { return Int64(number) }
        return 0
    }

    @available(iOS 17.0, *)
    private func syncEngine() async throws -> CKSyncEngine {
        let database = try privateDatabase()
        return try await ReplicaSyncEngineHolder.shared.engine(
            database: database,
            stateKey: Self.engineStateKey
        )
    }

    // Simulator builds carry no usable CloudKit container entitlement and
    // constructing the named container there traps before first paint. Every
    // installable device build is signed against App/App.entitlements; archive
    // and export fail if the selected profile cannot grant that container.
    private static func isCloudKitRuntimeSupported() -> Bool {
        #if targetEnvironment(simulator)
        return false
        #else
        return true
        #endif
    }

    private func resolvedContainer() -> CKContainer? {
        if let container {
            return container
        }
        guard Self.isCloudKitRuntimeSupported() else {
            return nil
        }
        let created = CKContainer(identifier: Self.containerIdentifier)
        container = created
        return created
    }

    private func requireContainer() throws -> CKContainer {
        guard let container = resolvedContainer() else {
            throw ReplicaError.unavailable
        }
        return container
    }

    private func requireKeys(_ call: CAPPluginCall, exactly expected: Set<String>) -> Bool {
        let keys = Set(call.options.keys.compactMap { $0 as? String })
        return keys == expected && call.options.keys.count == keys.count
    }

    private func reject(_ call: CAPPluginCall, underlying: Error? = nil) {
        call.reject(
            "The iCloud learning replica is unavailable.",
            "ICLOUD_REPLICA_UNAVAILABLE",
            underlying
        )
    }
}

private enum ReplicaError: Error {
    case conflict
    case invalid
    case unavailable
}

private final class ReplicaRecordCache: @unchecked Sendable {
    static let shared = ReplicaRecordCache()
    private var records: [CKRecord.ID: CKRecord] = [:]
    private var failedRecordIDs: Set<CKRecord.ID> = []
    private let lock = NSLock()

    func store(_ values: [CKRecord]) {
        lock.lock()
        defer { lock.unlock() }
        for record in values {
            records[record.recordID] = record
            failedRecordIDs.remove(record.recordID)
        }
    }

    func beginSend(_ ids: [CKRecord.ID]) {
        lock.lock()
        defer { lock.unlock() }
        for id in ids {
            failedRecordIDs.remove(id)
        }
    }

    func fail(_ id: CKRecord.ID, serverRecord: CKRecord?) {
        lock.lock()
        defer { lock.unlock() }
        if let serverRecord {
            records[id] = serverRecord
        }
        failedRecordIDs.insert(id)
    }

    func consumeFailures(_ ids: [CKRecord.ID]) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        var failed = false
        for id in ids where failedRecordIDs.remove(id) != nil {
            failed = true
        }
        return failed
    }

    func record(for id: CKRecord.ID) -> CKRecord? {
        lock.lock()
        defer { lock.unlock() }
        return records[id]
    }

    func remove(_ ids: [CKRecord.ID]) {
        lock.lock()
        defer { lock.unlock() }
        for id in ids {
            records.removeValue(forKey: id)
            failedRecordIDs.remove(id)
        }
    }

    func clear() {
        lock.lock()
        defer { lock.unlock() }
        records.removeAll()
        failedRecordIDs.removeAll()
    }
}

@available(iOS 17.0, *)
private final class ReplicaSyncEngineHolder: @unchecked Sendable {
    static let shared = ReplicaSyncEngineHolder()
    private var engine: CKSyncEngine?
    private var delegate: ReplicaSyncDelegate?
    private let lock = NSLock()

    func engine(database: CKDatabase, stateKey: String) async throws -> CKSyncEngine {
        lock.lock()
        if let engine {
            lock.unlock()
            return engine
        }
        lock.unlock()
        let saved = UserDefaults.standard.data(forKey: stateKey)
        let serialization = saved.flatMap {
            try? JSONDecoder().decode(CKSyncEngine.State.Serialization.self, from: $0)
        }
        let delegate = ReplicaSyncDelegate(stateKey: stateKey)
        let created = CKSyncEngine(
            CKSyncEngine.Configuration(
                database: database,
                stateSerialization: serialization,
                delegate: delegate
            )
        )
        lock.lock()
        self.delegate = delegate
        engine = created
        lock.unlock()
        return created
    }
}

@available(iOS 17.0, *)
private final class ReplicaSyncDelegate: NSObject, CKSyncEngineDelegate {
    private let stateKey: String

    init(stateKey: String) {
        self.stateKey = stateKey
    }

    func handleEvent(
        _ event: CKSyncEngine.Event,
        syncEngine: CKSyncEngine
    ) async {
        switch event {
        case .stateUpdate(let update):
            if let data = try? JSONEncoder().encode(update.stateSerialization) {
                UserDefaults.standard.set(data, forKey: stateKey)
            }
        case .accountChange:
            ReplicaRecordCache.shared.clear()
        case .fetchedRecordZoneChanges(let fetched):
            ReplicaRecordCache.shared.store(
                fetched.modifications.map(\.record)
            )
            ReplicaRecordCache.shared.remove(
                fetched.deletions.map(\.recordID)
            )
        case .sentRecordZoneChanges(let sent):
            ReplicaRecordCache.shared.store(sent.savedRecords)
            for failure in sent.failedRecordSaves {
                ReplicaRecordCache.shared.fail(
                    failure.record.recordID,
                    serverRecord: failure.error.serverRecord
                )
            }
        default:
            break
        }
    }

    func nextRecordZoneChangeBatch(
        _ context: CKSyncEngine.SendChangesContext,
        syncEngine: CKSyncEngine
    ) async -> CKSyncEngine.RecordZoneChangeBatch? {
        let changes = syncEngine.state.pendingRecordZoneChanges.filter {
            context.options.scope.contains($0)
        }
        return await CKSyncEngine.RecordZoneChangeBatch(
            pendingChanges: changes
        ) { recordID in
            ReplicaRecordCache.shared.record(for: recordID)
        }
    }
}
