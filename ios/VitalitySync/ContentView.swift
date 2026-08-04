import SwiftUI

/// One screen: is it configured, did it work, what came through.
///
/// Deliberately not a dashboard. Charts, history and every input live in the
/// web app — this exists only to prove the pipe is alive and to name the error
/// when it is not.
struct ContentView: View {
    @ObservedObject var sync: HealthSync

    @State private var endpoint = AppConfig.shared.endpoint?.absoluteString ?? ""
    @State private var token = ""
    @State private var configured = AppConfig.shared.isConfigured

    private static let stamp: DateFormatter = {
        let f = DateFormatter()
        f.dateStyle = .short
        f.timeStyle = .short
        return f
    }()

    var body: some View {
        NavigationStack {
            Form {
                if configured {
                    Section("Status") {
                        LabeledContent("Letzter Abgleich") {
                            Text(sync.lastSync.map { Self.stamp.string(from: $0) } ?? "noch keiner")
                                .foregroundStyle(.secondary)
                        }
                        if let r = sync.lastResult {
                            LabeledContent("Übertragen") {
                                Text("\(r.accepted.count) Werte für \(r.date)")
                                    .foregroundStyle(.secondary)
                            }
                            // Rejected keys are shown, not swallowed: that is how
                            // a wrong unit or a stale config becomes visible
                            // instead of a metric quietly never arriving.
                            if !r.rejected.isEmpty {
                                LabeledContent("Abgewiesen") {
                                    Text(r.rejected.joined(separator: ", "))
                                        .foregroundStyle(.orange)
                                }
                            }
                        }
                        if let e = sync.lastError {
                            Text(e).foregroundStyle(.red).font(.callout)
                        }
                    }

                    Section {
                        Button {
                            Task { await sync.sync() }
                        } label: {
                            if sync.busy { ProgressView() } else { Text("Jetzt abgleichen") }
                        }
                        .disabled(sync.busy)

                        Button("Gestern nachholen") {
                            Task {
                                let yesterday = Calendar.current.date(byAdding: .day, value: -1, to: Date())!
                                await sync.sync(day: yesterday)
                            }
                        }
                        .disabled(sync.busy)
                    } footer: {
                        Text("Läuft sonst von selbst, sobald Health neue Daten bekommt.")
                    }

                    Section {
                        Button("Zugang ändern", role: .destructive) { configured = false }
                    }
                } else {
                    Section {
                        TextField("https://…", text: $endpoint)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .keyboardType(.URL)
                        SecureField("HEALTH_TOKEN", text: $token)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                    } header: {
                        Text("Dashboard")
                    } footer: {
                        Text("Beides steht in .env.local des Dashboards. Das Token bleibt im Schlüsselbund dieses Geräts.")
                    }
                    Section {
                        Button("Verbinden") {
                            AppConfig.shared.endpoint = URL(string: endpoint.trimmingCharacters(in: .whitespaces))
                            AppConfig.shared.token = token.trimmingCharacters(in: .whitespaces)
                            token = ""
                            configured = AppConfig.shared.isConfigured
                            Task {
                                try? await sync.requestAuthorization()
                                await sync.startObserving()
                                await sync.sync()
                            }
                        }
                        .disabled(endpoint.isEmpty || token.isEmpty)
                    }
                }
            }
            .navigationTitle("Vitality Sync")
        }
    }
}
