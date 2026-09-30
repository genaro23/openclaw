#if os(macOS)
import Foundation
import OpenClawProtocol

@MainActor
struct ChatSidebarCatalogPresentation {
    struct Host: Identifiable {
        let source: SessionCatalogHost
        let rows: [SessionCatalogSession]
        var id: String {
            self.source.hostid
        }
    }

    struct Catalog: Identifiable {
        let source: SessionCatalog
        let hosts: [Host]
        var id: String {
            self.source.id
        }
    }

    enum OwnerFilter: Hashable {
        case all, involvingMe, owner(String)

        init(_ query: OpenClawChatSidebarQuery) {
            self = query.involvingMe == true ? .involvingMe : query.ownerId.map(Self.owner) ?? .all
        }

        func applying(to query: OpenClawChatSidebarQuery) -> OpenClawChatSidebarQuery {
            var query = query
            query.ownerId = nil
            query.involvingMe = nil
            switch self {
            case .all: break
            case .involvingMe: query.involvingMe = true
            case let .owner(id): query.ownerId = id
            }
            return query
        }
    }

    static func selfUser(_ people: OpenClawChatSidebarPeople?) -> OpenClawChatSidebarPeople.User? {
        guard let people else { return nil }
        return people.people.first { $0.id == people.selfKey }?.user
    }

    static func owners(for viewModel: OpenClawChatViewModel, people: OpenClawChatSidebarPeople?)
        -> [OpenClawChatSessionEntry.CreatedActor]
    {
        var owners = viewModel.sidebarData?.result?.owners ?? []
        // app-sidebar-session-ownership.ts:59 keeps self available without owned rows, except agent-ID collisions.
        if let user = Self.selfUser(people), !owners.contains(where: { $0.id == user.id && $0.type == "agent" }) {
            owners.removeAll { $0.id == user.id }
            owners.insert(
                .init(type: "human", id: user.id, label: user.name, avatarUrl: user.avatarUrl, identity: nil),
                at: 0)
        }
        return owners
    }

    static func query(for viewModel: OpenClawChatViewModel, people: OpenClawChatSidebarPeople? = nil)
        -> OpenClawChatSidebarQuery
    {
        var query = viewModel.sidebarData?.query ?? .init(agentID: viewModel.selectedAgentID)
        // app-sidebar-session-ownership.ts:74 treats a present facet as the complete owner inventory.
        if viewModel.sidebarData?.result?.owners != nil, let selected = query.ownerId,
           !Self.owners(for: viewModel, people: people).contains(where: { $0.id == selected }) { query.ownerId = nil }
        return query
    }

    struct VisibilityOption: Identifiable {
        let id: String
        let label: String
    }

    static func visibilityOptions(_ catalogs: [SessionCatalog], hidden: Set<String>) -> [VisibilityOption] {
        let known = Set(catalogs.map(\.id))
        return catalogs.map { .init(id: $0.id, label: $0.label) } + hidden.subtracting(known).sorted().map {
            .init(id: $0, label: $0)
        }
    }

    let catalogs: [Catalog]
    let liveRows: [String: OpenClawChatSessionEntry]

    init(
        sources: [SessionCatalog], requestErrors: [String: String] = [:],
        query: OpenClawChatSidebarQuery, allAgents: Bool,
        lookup: (String) -> OpenClawChatSessionEntry?)
    {
        var liveRows: [String: OpenClawChatSessionEntry] = [:]
        for key in sources.flatMap(\.hosts).flatMap(\.sessions).compactMap(\.sessionkey) {
            liveRows[key] = lookup(key)
        }
        self.liveRows = liveRows
        // app-sidebar.ts:464 uses the all-agent roster instead of catalog sections.
        let sources = query.status == .archived || allAgents ? [] : sources
        // app-sidebar-session-ownership.ts:93: involvement is Gateway-owned, never an owner filter.
        let owner = query.involvingMe == true ? nil : query.ownerId
        self.catalogs = sources.compactMap { catalog in
            let hosts = catalog.hosts.compactMap { host -> Host? in
                let rows = ChatSessionSidebarCatalogs.filtered(host.sessions, owner: owner, live: liveRows)
                return rows.isEmpty ? nil : Host(source: host, rows: rows)
            }
            let failed = !Self.errors(catalog, requestError: requestErrors[catalog.id]).isEmpty
            return hosts.isEmpty && !failed ? nil : Catalog(source: catalog, hosts: hosts)
        }
    }

    static func ordinarySections(
        _ sections: [ChatSessionSidebarModel.Section], excluding: Set<String>, rankedSearch: Bool = false,
        currentKey: String, currentIsKnown: Bool) -> [ChatSessionSidebarModel.Section]
    {
        // lib/sessions/navigation.ts:253 never synthesizes an ordinary row for an unadopted catalog route.
        let rawCatalog = !currentIsKnown && Self.isCatalogKey(currentKey) ? currentKey : nil
        guard !excluding.isEmpty || rawCatalog != nil else { return sections }
        return sections.compactMap { section in
            let nodes: [ChatSessionSidebarModel.Node]
            if rankedSearch {
                // Search owns flat relevance order; rebuilding its tree hides matching children.
                nodes = section.nodes.filter { $0.session.key != rawCatalog }
            } else {
                // A projected forest may repeat a row; reparent each canonical agent/key only once.
                var seen = Set<OpenClawChatSessionTarget>()
                let rows = section.nodes.flatMap(\.previewSessions).filter {
                    !excluding.contains($0.key) && $0.key != rawCatalog &&
                        seen.insert(.init(sessionKey: $0.key, agentID: $0.agentId)).inserted
                }
                nodes = ChatSessionSidebarModel.tree(from: rows)
            }
            return nodes.isEmpty ? nil : .init(id: section.id, title: section.title, nodes: nodes)
        }
    }

    static func isCatalogKey(_ key: String) -> Bool {
        self.catalogSource(key) != nil
    }

    private static func catalogSource(_ key: String) -> [Data]? {
        let parts = key.components(separatedBy: ":")
        if parts.first == "agent", parts.count < 2 || parts[1].isEmpty { return nil }
        let source = parts.first == "agent" ? Array(parts.dropFirst(2)) : parts
        guard source.count == 4, source[0] == "catalog" else { return nil }
        let decoded = source.dropFirst().compactMap { part -> Data? in
            guard let value = part.removingPercentEncoding, !value.isEmpty else { return nil }
            // Opaque IDs use exact bytes, without Swift String's canonical Unicode equivalence.
            return Data(value.utf8)
        }
        return decoded.count == 3 ? decoded : nil
    }

    static func target(catalogID: String, hostID: String, row: SessionCatalogSession, agentID: String)
        -> OpenClawChatSessionTarget
    {
        guard let key = row.sessionkey else {
            return self.sourceTarget(catalogID: catalogID, hostID: hostID, row: row, agentID: agentID)
        }
        return .init(sessionKey: key, agentID: OpenClawChatSessionKey.agentID(from: key) ?? agentID)
    }

    static func sourceTarget(catalogID: String, hostID: String, row: SessionCatalogSession, agentID: String)
        -> OpenClawChatSessionTarget
    {
        let allowed =
            CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()")
        let parts = [catalogID, hostID, row.threadid].map { $0.addingPercentEncoding(withAllowedCharacters: allowed)! }
        // ui/src/lib/sessions/catalog-key.ts:80 keeps the source independent of its adopted conversation.
        return .init(
            sessionKey: "agent:\(agentID.lowercased()):catalog:" + parts.joined(separator: ":"),
            agentID: agentID.lowercased())
    }

    static func shouldLeaveDeletedSource(
        _ source: OpenClawChatSessionTarget,
        current: OpenClawChatSessionTarget) -> Bool
    {
        // app-sidebar-catalog-menu.ts:155 compares source IDs even when its row has since been adopted.
        guard let identity = catalogSource(source.sessionKey) else { return false }
        return source.agentID == current.agentID && identity == Self.catalogSource(current.sessionKey)
    }

    static func title(_ row: SessionCatalogSession) -> String {
        row.name.flatMap { $0.isEmpty ? nil : $0 } ?? row.threadid
    }

    static func errors(_ catalog: SessionCatalog, requestError: String?) -> [String] {
        var seen = Set<String>()
        let errors = [catalog.error] + catalog.hosts.compactMap {
            $0.error?["code"]?.value as? String == "NODE_OFFLINE" ? nil : $0.error
        }
        return ([requestError] + errors.compactMap { error -> String? in
            guard let error else { return nil }
            return [
                (error["code"]?.value as? String).map { "[\($0)]" }, error["message"]?.value as? String,
            ].compactMap(\.self).joined(separator: " ")
        }).compactMap(\.self).filter { !$0.isEmpty && seen.insert($0).inserted }
    }
}
#endif
