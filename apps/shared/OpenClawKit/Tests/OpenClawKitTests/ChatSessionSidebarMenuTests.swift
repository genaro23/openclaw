#if os(macOS)
import Foundation
import OpenClawProtocol
import Testing
@testable import OpenClawChatUI

@MainActor
func sidebarMenuConnection(
    current: @escaping () -> Bool = { true }, local: Bool = false, selfProfileID: String? = nil,
    scopes: [String] = ["operator.admin"],
    request: @escaping (OpenClawChatGatewayRequest) async throws -> Data) throws -> OpenClawSessionMenuConnection
{
    var payload = try #require(JSONSerialization.jsonObject(with: Data(#"""
    {"type":"hello-ok","protocol":3,"server":{},
     "features":{"methods":["sessions.patch","sessions.assignOwner","users.list","users.self","chat.history"]},
     "snapshot":{"presence":[],"health":{},"stateVersion":{"presence":0,"health":0},"uptimeMs":0},
     "auth":{"scopes":["operator.admin"]},"policy":{}}
    """#.utf8)) as? [String: Any])
    payload["auth"] = ["scopes": scopes]
    let hello = try JSONDecoder().decode(HelloOk.self, from: JSONSerialization.data(withJSONObject: payload))
    return OpenClawSessionMenuConnection(
        hello: hello,
        local: local,
        selfProfileID: selfProfileID,
        isCurrent: current,
        request: request,
        link: { _, _ in nil },
        openWindow: { _ in })
}

@MainActor
struct ChatSessionSidebarMenuTests {
    @Test func `appearance reset and involvement address the row incarnation and agent`() async throws {
        let session = try JSONDecoder().decode(OpenClawChatSessionEntry.self, from: Data(#"""
        {"key":"agent:research:release-plan","sessionId":"durable-123","agentId":"stale-agent"}
        """#.utf8))
        var sent: [OpenClawChatGatewayRequest] = []
        let connection = try sidebarMenuConnection { request in
            sent.append(request)
            return Data(#"{"ok":true}"#.utf8)
        }
        try await connection.request(OpenClawChatGatewayRequests.sessionMenu(
            "sessions.patch",
            session: session,
            fields: [
                "icon": .init(NSNull()),
                "color": .init(NSNull()),
            ]))
        try await connection.request(OpenClawChatGatewayRequests.sessionMenu(
            "sessions.setInvolvement",
            session: session,
            fields: [
                "hidden": .init(true),
                "expectedSessionId": .init(#require(session
                        .sessionId)),
            ]))
        let reset = try JSONSerialization.jsonObject(with: JSONEncoder().encode(sent[0].params)) as? NSDictionary
        #expect(reset == [
            "key": "agent:research:release-plan",
            "agentId": "research",
            "icon": NSNull(),
            "color": NSNull(),
            "expectedSessionId": "durable-123",
        ] as NSDictionary)
        let involvement = try JSONSerialization.jsonObject(with: JSONEncoder().encode(sent[1].params)) as? NSDictionary
        #expect(involvement == [
            "key": "agent:research:release-plan",
            "agentId": "research",
            "expectedSessionId": "durable-123",
            "hidden": true,
        ] as NSDictionary)
    }

    @Test func `directory failure retains known human ownership and retry restores the roster`() async throws {
        let session = try JSONDecoder().decode(OpenClawChatSessionEntry.self, from: Data(#"""
        {"key":"agent:research:release-plan","owner":{"actor":{"type":"human","id":"ada","label":"Ada"}}}
        """#.utf8))
        var failing = true
        let connection = try sidebarMenuConnection { request in
            if request.method == "users.self" {
                return Data(#"{"profile":{"id":"self","emails":[],"displayName":"Operator"}}"#.utf8)
            }
            if failing { throw URLError(.networkConnectionLost) }
            return Data(#"""
            {"profiles":[{"id":"self","emails":[]},{"id":"ada","emails":[],"displayName":"Ada"},
             {"id":"retired","emails":[],"mergedInto":"ada"}]}
            """#.utf8)
        }
        let actions = ChatSessionSidebarActions()
        await actions.load(session: session, agents: [], acquire: { connection })
        #expect(actions.owners.map(\.key) == ["self", "ada"])
        #expect(actions.directoryError != nil)
        failing = false
        await actions.loadOwners(session: session, agents: [])
        #expect(actions.owners.map(\.key) == ["self", "ada"])
        #expect(actions.directoryError == nil)
    }

    @Test func `retired connections reject mutations before dispatch and directory replies after dispatch`() async throws {
        var current = false
        var calls = 0
        let connection = try sidebarMenuConnection(current: { current }) { _ in
            calls += 1
            current = false
            return Data(#"{"profiles":[]}"#.utf8)
        }
        await #expect(throws: CancellationError.self) {
            try await connection.request(.init(method: "sessions.patch", timeoutMs: 15000))
        }
        #expect(calls == 0)
        current = true
        await #expect(throws: CancellationError.self) {
            let _: [String: [String]] = try await connection.read("users.list")
        }
        #expect(calls == 1)
    }

    @Test(arguments: ["cursor", "vscode", "windsurf", "zed"])
    func `editor URLs preserve local path segments`(_ editor: String) throws {
        let url = try #require(ChatSessionSidebarActions.editorURL(editor, path: "/work/release #1/a?b%20"))
        #expect(url.absoluteString == "\(editor)://file/work/release%20%231/a%3Fb%2520")
        #expect(ChatSessionSidebarActions.editorURL(editor, path: "relative/path") == nil)
        #expect(ChatSessionSidebarActions.editorURL("https", path: "/work/project") == nil)
    }

    @Test(arguments: [("🦞", true), (" 👩‍💻 ", true), ("🇦🇹", true), ("a", false), ("🦞🚀", false), ("", false)])
    func `custom emoji uses one bounded grapheme`(_ entry: (String, Bool)) {
        #expect(ChatSessionIconPicker.acceptsCustomEmoji(entry.0) == entry.1)
    }

    @Test(arguments: [(false, false, false), (true, false, false), (true, true, false), (true, false, true)])
    func `editor destinations require a live local worktree`(_ options: (Bool, Bool, Bool)) async throws {
        let (local, remoteNode, removed) = options
        var row: [String: Any] = ["key": "agent:research:thread", "worktree": ["id": "wt-1"]]
        if remoteNode { row["execNode"] = "other-machine" }
        let session = try JSONDecoder().decode(
            OpenClawChatSessionEntry.self,
            from: JSONSerialization.data(withJSONObject: row))
        var worktreeReads = 0
        let connection = try sidebarMenuConnection(local: local) { request in
            if request.method == "users.self" { return Data(#"{"profile":{"id":"me","emails":[]}}"#.utf8) }
            if request.method == "users.list" { return Data(#"{"profiles":[]}"#.utf8) }
            #expect(request.method == "worktrees.list")
            worktreeReads += 1
            var worktree: [String: Any] = [
                "id": "wt-1",
                "name": "working copy",
                "repoFingerprint": "repo-1",
                "repoRoot": "/work/repo",
                "path": "/work/copy",
                "branch": "feature",
                "baseRef": "main",
                "ownerKind": "session",
                "createdAt": 1,
                "lastActiveAt": 2,
            ]
            if removed { worktree["removedAt"] = 3 }
            return try JSONSerialization.data(withJSONObject: ["worktrees": [worktree]])
        }
        let actions = ChatSessionSidebarActions()
        await actions.load(session: session, agents: [], acquire: { connection })
        #expect(worktreeReads == (local && !remoteNode ? 1 : 0))
        #expect(actions.worktreePath == (local && !remoteNode && !removed ? "/work/copy" : nil))
    }

    @Test func `hello identity retains Me when profile refresh is unavailable`() async throws {
        let session = try JSONDecoder().decode(
            OpenClawChatSessionEntry.self,
            from: Data(#"{"key":"agent:research:thread"}"#.utf8))
        let connection = try sidebarMenuConnection(selfProfileID: "self") { request in
            if request.method == "users.self" { throw URLError(.networkConnectionLost) }
            return Data(#"{"profiles":[{"id":"self","emails":[]},{"id":"ada","emails":["ada@example.test"]}]}"#.utf8)
        }
        let actions = ChatSessionSidebarActions()
        await actions.load(session: session, agents: [], acquire: { connection })
        #expect(actions.owners.map(\.key) == ["self", "ada"])
        #expect(actions.directoryError == nil)
    }

    @Test(arguments: [
        "operator.sessions.read",
        "operator.sessions.write",
        "operator.read",
        "operator.write",
        "operator.admin",
    ])
    func `Markdown accepts scoped reads without widening appearance writes`(_ scope: String) throws {
        let connection = try sidebarMenuConnection(scopes: [scope]) { _ in Data() }
        #expect(connection.allows("chat.history", scope: "operator.sessions.read"))
        #expect(connection.allows("sessions.patch") == ["operator.write", "operator.admin"].contains(scope))
    }

    @Test func `implicit home links stay groupable while explicit children do not`() throws {
        var row: [String: Any] = [
            "key": "agent:research:release-plan",
            "parentSessionKey": "agent:research:main",
            "createdVia": "operator",
            "spawnDepth": 0,
        ]
        func canGroup() throws -> Bool {
            let session = try JSONDecoder().decode(
                OpenClawChatSessionEntry.self,
                from: JSONSerialization.data(withJSONObject: row))
            return ChatSessionSidebarActions.canMoveToGroup(session, mainKeys: ["agent:research:main"])
        }
        #expect(try canGroup())
        row["parentSessionId"] = "explicit-parent"
        #expect(try !canGroup())
        row.removeValue(forKey: "parentSessionId")
        row["spawnedBy"] = "agent:research:main"
        #expect(try !canGroup())
        row.removeValue(forKey: "spawnedBy")
        row["key"] = "agent:research:subagent:run"
        #expect(try !canGroup())
    }
}
#endif
