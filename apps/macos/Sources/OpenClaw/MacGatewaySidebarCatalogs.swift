import Foundation
import OpenClawChatUI
import OpenClawKit

extension MacGatewayChatTransport: OpenClawSidebarCatalogTransport {
    @MainActor
    func catalogEvents() async -> AsyncStream<OpenClawSidebarCatalogEvent> {
        AsyncStream { continuation in
            let task = Task { @MainActor in
                var observedLease: GatewayConnection.ServerLease?
                var changedEvents = false
                for await delivery in await self.connection.subscribe() {
                    guard !Task.isCancelled else { break }
                    if case .disconnected = delivery.event, observedLease == delivery.serverLease {
                        observedLease = nil
                        changedEvents = false
                        continuation.yield(.disconnected)
                    }
                    guard delivery.isCurrent, let push = delivery.push else { continue }
                    switch push {
                    case let .snapshot(hello):
                        observedLease = delivery.serverLease
                        changedEvents = false
                        guard hello.advertisedServerMethods()?.contains("sessions.catalog.list") == true,
                              await self.currentOutboxGatewayMatchesConnection(),
                              !Task.isCancelled, delivery.isCurrent
                        else {
                            continuation.yield(.unavailable)
                            continue
                        }
                        changedEvents = hello.features["events"]?.arrayValue?.contains {
                            $0.stringValue == "sessions.catalog.changed"
                        } == true
                        let lease = delivery.serverLease
                        let primaryScope = self.connection === GatewayConnection.shared
                            ? MacChatTranscriptCache.currentGatewayID() : nil
                        let profileID = self.outboxGatewayID ??
                            primaryScope ??
                            lease.route.browserSession?.chatStoreID(profileID: lease.route.url.absoluteString) ??
                            lease.route.url.absoluteString
                        continuation.yield(.connected(OpenClawSidebarCatalogConnection(
                            profileID: profileID,
                            changedEvents: changedEvents,
                            request: { request in
                                try await self.connection.request(request, ifCurrentServerLease: lease)
                            },
                            isCurrent: { self.connection.serverLeaseMatchesCurrentState(lease) })))
                    case let .event(event) where changedEvents && event.event == "sessions.catalog.changed":
                        continuation.yield(.changed(event.payload?.dictionaryValue?["agentId"]?.stringValue))
                    default: break
                    }
                }
                continuation.finish()
            }
            continuation.onTermination = { @Sendable _ in task.cancel() }
        }
    }
}
