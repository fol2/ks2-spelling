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

    private let container = CKContainer(identifier: "iCloud.uk.eugnel.ks2spelling")
    private let zoneID = CKRecordZone.ID(
        zoneName: ICloudLearningReplicaPlugin.zoneName,
        ownerName: CKCurrentUserDefaultName
    )

    @objc public func getStatus(_ call: CAPPluginCall) {
        guard requireKeys(call, exactly: []) else {
            reject(call)
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

    private var privateDatabase: CKDatabase {
        container.privateCloudDatabase
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
        _ = try await privateDatabase.modifyRecordZones(saving: [zone], deleting: [])
        if #available(iOS 17.0, *) {
            _ = try await syncEngine()
        }
    }

    private func save(_ records: [CKRecord]) async throws {
        if #available(iOS 17.0, *) {
            let engine = try await syncEngine()
            engine.state.add(pendingRecordZoneChanges: records.map {
                .saveRecord($0.recordID)
            })
            ReplicaRecordCache.shared.store(records)
            try await engine.sendChanges()
            return
        }
        _ = try await privateDatabase.modifyRecords(saving: records, deleting: [])
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
            let result = try await privateDatabase.records(
                matching: query,
                inZoneWith: zoneID
            )
            return try result.matchResults.map { _, recordResult in
                try recordResult.get()
            }
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
            let record = CKRecord(recordType: Self.profileRecordType, recordID: recordID)
            record["payload"] = try encodeJSON(profile)
            record["updatedAt"] = int64(profile["updatedAt"])
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
            let record = CKRecord(recordType: Self.snapshotRecordType, recordID: recordID)
            record["payload"] = try makeAsset(snapshot["payload"])
            record["updatedAt"] = int64((snapshot["payload"] as? JSObject)?["revision"])
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
              let data = try? Data(contentsOf: fileURL),
              let payload = try JSONSerialization.jsonObject(with: data)
        else {
            throw ReplicaError.invalid
        }
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

    private func int64(_ value: Any?) -> Int64 {
        if let number = value as? NSNumber { return number.int64Value }
        if let number = value as? Int { return Int64(number) }
        return 0
    }

    @available(iOS 17.0, *)
    private func syncEngine() async throws -> CKSyncEngine {
        try await ReplicaSyncEngineHolder.shared.engine(
            database: privateDatabase,
            stateKey: Self.engineStateKey
        )
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
    case invalid
}

private final class ReplicaRecordCache: @unchecked Sendable {
    static let shared = ReplicaRecordCache()
    private var records: [CKRecord.ID: CKRecord] = [:]
    private let lock = NSLock()

    func store(_ values: [CKRecord]) {
        lock.lock()
        defer { lock.unlock() }
        for record in values {
            records[record.recordID] = record
        }
    }

    func record(for id: CKRecord.ID) -> CKRecord? {
        lock.lock()
        defer { lock.unlock() }
        return records[id]
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
        default:
            break
        }
    }

    func nextRecordZoneChangeBatch(
        _ context: CKSyncEngine.SendChangesContext,
        syncEngine: CKSyncEngine
    ) async -> CKSyncEngine.RecordZoneChangeBatch? {
        _ = context
        return await CKSyncEngine.RecordZoneChangeBatch(
            pendingChanges: syncEngine.state.pendingRecordZoneChanges
        ) { recordID in
            ReplicaRecordCache.shared.record(for: recordID)
        }
    }
}
