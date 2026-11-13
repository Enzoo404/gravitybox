import Foundation

struct UsageQueryIdentity: Equatable {
    let period: String

    func matches(_ report: [String: Any]) -> Bool {
        return report["period"] as? String == period
    }
}
