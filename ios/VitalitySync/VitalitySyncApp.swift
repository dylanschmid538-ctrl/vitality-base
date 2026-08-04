import SwiftUI

@main
struct VitalitySyncApp: App {
    @StateObject private var sync = HealthSync()

    var body: some Scene {
        WindowGroup {
            ContentView(sync: sync)
                .task {
                    // Permissions and observers on every launch: iOS only shows
                    // the sheet for types not yet decided, so a metric added on
                    // the server later gets its permission on the next start
                    // without any change to this app.
                    guard AppConfig.shared.isConfigured else { return }
                    try? await sync.requestAuthorization()
                    await sync.startObserving()
                    await sync.sync()
                }
        }
    }
}
