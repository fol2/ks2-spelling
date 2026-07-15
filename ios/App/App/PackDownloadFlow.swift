import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

enum PackTransferError: Error, Equatable {
    case rejected
    case capabilityExpired
    case rangeNotSatisfiable

    var safeCode: String {
        switch self {
        case .rejected: return "PACK_TRANSFER_REJECTED"
        case .capabilityExpired: return "PACK_CAPABILITY_EXPIRED"
        case .rangeNotSatisfiable: return "PACK_RANGE_NOT_SATISFIABLE"
        }
    }
}

struct DownloadResponse {
    let data: Data
    let response: HTTPURLResponse
}

protocol PackDownloadTransport: AnyObject {
    func fetch(_ request: URLRequest) throws -> DownloadResponse
}

struct PackDownloadRequest {
    let capabilityURL: String
    let packId: String
    let version: String
    let archiveName: String
    let startByte: Int
    let endByteExclusive: Int
    let truncate: Bool
}

struct PackDownloadOutcome {
    let response: DownloadResponse
    let range: ValidatedPackRange
}

enum PackDownloadFlow {
    static func execute(
        _ input: PackDownloadRequest,
        beforeTransport: () throws -> Void,
        transport: PackDownloadTransport
    ) throws -> PackDownloadOutcome {
        guard input.startByte >= 0,
              input.endByteExclusive > input.startByte,
              input.endByteExclusive <= 1_048_576,
              !input.truncate || input.startByte == 0 else {
            throw PackTransferError.rejected
        }
        let capabilityURL: URL
        do {
            capabilityURL = try PackCapabilityValidator.validateCapabilityURL(
                input.capabilityURL,
                packId: input.packId,
                version: input.version,
                archiveName: input.archiveName
            )
        } catch {
            throw PackTransferError.rejected
        }
        var request = URLRequest(url: capabilityURL)
        request.httpMethod = "GET"
        request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        request.timeoutInterval = 30
        request.setValue("capacitor://localhost", forHTTPHeaderField: "Origin")
        request.setValue(
            "bytes=\(input.startByte)-\(input.endByteExclusive - 1)",
            forHTTPHeaderField: "Range"
        )
        request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")

        try beforeTransport()
        let response = try transport.fetch(request)
        guard response.response.url?.absoluteString == capabilityURL.absoluteString else {
            throw PackTransferError.rejected
        }
        if response.response.statusCode == 400 {
            throw PackTransferError.capabilityExpired
        }
        if response.response.statusCode == 416, response.data.isEmpty {
            throw PackTransferError.rangeNotSatisfiable
        }
        let range: ValidatedPackRange
        do {
            range = try PackRangeResponseValidator.validate(
                statusCode: response.response.statusCode,
                responseURL: response.response.url,
                expectedURL: capabilityURL,
                etag: response.response.value(forHTTPHeaderField: "ETag"),
                contentRange: response.response.value(forHTTPHeaderField: "Content-Range"),
                bodyBytes: response.data.count,
                requestedStart: input.startByte,
                requestedEndExclusive: input.endByteExclusive
            )
        } catch {
            throw PackTransferError.rejected
        }
        return PackDownloadOutcome(response: response, range: range)
    }
}
