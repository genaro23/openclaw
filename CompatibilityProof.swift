import Foundation
enum Old {
 enum SidebarDestination: String, CaseIterable {
        case chat
        case overview
        case activity
        case agents
        case workboard
        case skillWorkshop
        case instances
        case sessions
        case files
        case dreaming
        case usage
        case cron
        case desktop
        case terminal
        case docs
        case settings
        case gateway


}
    static let sidebarDestinations: [SidebarDestination] = [
        .chat,
        .overview,
        .workboard,
        .usage,
        .cron,
        .sessions,
        .activity,
        .skillWorkshop,
        .agents,
        .instances,
        .files,
        .dreaming,
        .desktop,
        .terminal,
        .docs,
    ]
 static let pinnableSidebarPages = sidebarDestinations.filter { $0 != .chat }
    static let defaultPinnedSidebarPages: [SidebarDestination] = [.overview, .usage, .cron]
    static func pinnedSidebarPages(from storage: String) -> [SidebarDestination] {
        let trimmed = storage.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return self.defaultPinnedSidebarPages }
        if trimmed == "none" { return [] }
        var seen = Set<String>()
        return trimmed.split(separator: ",").compactMap { raw in
            let value = String(raw)
            guard seen.insert(value).inserted,
                  let destination = SidebarDestination(rawValue: value),
                  self.pinnableSidebarPages.contains(destination)
            else { return nil }
            return destination
        }
    }
    static func pinnedSidebarPagesStorage(_ pages: [SidebarDestination]) -> String {
        pages.isEmpty ? "none" : pages.map(\.rawValue).joined(separator: ",")
    }
}
enum New {
 enum SidebarDestination: String, CaseIterable {
        case chat
        case overview
        case activity
        case systems
        case agents
        case workboard
        case skillWorkshop
        case instances
        case sessions
        case files
        case dreaming
        case usage
        case cron
        case desktop
        case terminal
        case docs
        case settings
        case gateway


}
    static let sidebarDestinations: [SidebarDestination] = [
        .chat,
        .overview,
        .workboard,
        .usage,
        .cron,
        .sessions,
        .activity,
        .systems,
        .skillWorkshop,
        .agents,
        .instances,
        .files,
        .dreaming,
        .desktop,
        .terminal,
        .docs,
    ]
 static let pinnableSidebarPages = sidebarDestinations.filter { $0 != .chat }
    static let defaultPinnedSidebarPages: [SidebarDestination] = [.overview, .systems, .usage, .cron]
    static func pinnedSidebarPages(from storage: String) -> [SidebarDestination] {
        let trimmed = storage.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return self.defaultPinnedSidebarPages }
        if trimmed == "none" { return [] }
        var seen = Set<String>()
        return trimmed.split(separator: ",").compactMap { raw in
            let value = String(raw)
            guard seen.insert(value).inserted,
                  let destination = SidebarDestination(rawValue: value),
                  self.pinnableSidebarPages.contains(destination)
            else { return nil }
            return destination
        }
    }
    static func pinnedSidebarPagesStorage(_ pages: [SidebarDestination]) -> String {
        pages.isEmpty ? "none" : pages.map(\.rawValue).joined(separator: ",")
    }
}

var count = 0
func check(_ raw: String) {
 let old = Old.pinnedSidebarPages(from: raw).map(\.rawValue)
 let new = New.pinnedSidebarPages(from: raw).map(\.rawValue)
 precondition(old == new, "Changed saved layout: \(raw)")
 let saved = New.pinnedSidebarPagesStorage(New.pinnedSidebarPages(from: raw))
 precondition(New.pinnedSidebarPages(from: saved).map(\.rawValue) == old, "Roundtrip: \(raw)")
 precondition(!new.contains("systems"), "Forced Systems into saved layout")
 count += 1
}
let keys = Old.pinnableSidebarPages.map(\.rawValue)
for mask in 0..<(1 << keys.count) {
 let subset = keys.enumerated().filter { mask & (1 << $0.offset) != 0 }.map { $0.element }
 check(subset.isEmpty ? "none" : subset.joined(separator: ","))
 check(subset.isEmpty ? "none" : subset.reversed().joined(separator: ","))
}
for a in keys { for b in keys where a != b { check(a + "," + b) } }
for raw in ["none", "usage,usage,docs", "chat,bogus", "chat,overview", "usage,,docs", ",", "unknown", "settings,gateway", " usage,docs ", "usage, docs", "none,usage", "usage,unknown,docs"] { check(raw) }
for raw in ["", " ", "\n"] {
 precondition(Old.pinnedSidebarPages(from: raw).map(\.rawValue) == ["overview","usage","cron"])
 precondition(New.pinnedSidebarPages(from: raw).map(\.rawValue) == ["overview","systems","usage","cron"])
}
precondition(New.pinnedSidebarPages(from:"docs,systems,usage").map(\.rawValue) == ["docs","systems","usage"])
print("PASS: \(count) saved-layout differential + round-trip cases; \(1 << keys.count) subsets, forward/reverse ordering, all ordered pairs, edge cases; 3 intentional default cases; explicit Systems opt-in.")
