import Foundation

struct UsageQueryIdentity: Equatable {
    let accountId: String
    let period: String

    func matches(_ report: [String: Any]) -> Bool {
        let summary = report["summary"] as? [String: Any] ?? [:]
        let reportedAccount = report["selectedAccountId"] as? String
            ?? summary["selectedAccountId"] as? String ?? "all"
        return reportedAccount == accountId && report["period"] as? String == period
    }
}
