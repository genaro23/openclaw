#if os(macOS)
import AppKit
import SwiftUI

struct ChatSidebarCatalogLifecycle: ViewModifier {
    let data: ChatSessionSidebarCatalogs
    let viewModel: OpenClawChatViewModel
    @State private var visible = false

    func body(content: Content) -> some View {
        content.background(CatalogSidebarVisibility(visible: self.$visible))
            .onReceive(NotificationCenter.default.publisher(for: UserDefaults.didChangeNotification)) { _ in
                self.data.reloadPreferences()
            }
            .task(id: "\(self.visible)|\(self.viewModel.selectedAgentID ?? "")") {
                guard self.visible, let agentID = self.viewModel.selectedAgentID,
                      let transport = self.viewModel.defaultTransport as? any OpenClawSidebarCatalogTransport
                else { return }
                await self.data.observe(transport.catalogEvents(), agentID: agentID)
            }
    }
}

private struct CatalogSidebarVisibility: NSViewRepresentable {
    @Binding var visible: Bool
    func makeNSView(context: Context) -> Probe {
        Probe()
    }

    func updateNSView(_ view: Probe, context: Context) {
        view.changed = { self.visible = $0 }
        view.updateVisibility()
    }

    final class Probe: NSView {
        var changed: ((Bool) -> Void)?
        override func viewDidMoveToWindow() {
            NotificationCenter.default.removeObserver(self)
            if let window {
                NotificationCenter.default.addObserver(
                    self,
                    selector: #selector(self.updateVisibility),
                    name: NSWindow.didChangeOcclusionStateNotification,
                    object: window)
            }
            self.updateVisibility()
        }

        @objc func updateVisibility() {
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.changed?(self.window?.occlusionState.contains(.visible) == true &&
                    !self.isHiddenOrHasHiddenAncestor && !self.visibleRect.isEmpty)
            }
        }

        override func viewDidHide() {
            self.updateVisibility()
        }

        override func viewDidUnhide() {
            self.updateVisibility()
        }

        override func layout() {
            super.layout()
            self.updateVisibility()
        }

        deinit { NotificationCenter.default.removeObserver(self) }
    }
}
#endif
