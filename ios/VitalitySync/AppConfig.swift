import Foundation
import Security

/// Endpoint and bearer token.
///
/// Named AppConfig, not Settings: SwiftUI has its own `Settings` scene type and
/// the collision makes Xcode paint the file red even when it compiles fine.
///
/// The token is NOT in the source and NOT in the repo — it would be committed,
/// and it is the credential that can write into the dashboard. It is typed in
/// once on the phone and kept in the Keychain, which survives app updates and
/// is encrypted at rest. The endpoint is ordinary settings and lives in
/// UserDefaults.
final class AppConfig {
    static let shared = AppConfig()
    private init() {}

    private let endpointKey = "endpoint"
    private let service = "ch.schmid.vitality.sync"
    private let account = "healthToken"

    var endpoint: URL? {
        get {
            guard let s = UserDefaults.standard.string(forKey: endpointKey) else { return nil }
            return URL(string: s)
        }
        set { UserDefaults.standard.set(newValue?.absoluteString, forKey: endpointKey) }
    }

    var token: String? {
        get {
            let query: [String: Any] = [
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: service,
                kSecAttrAccount as String: account,
                kSecReturnData as String: true,
            ]
            var item: CFTypeRef?
            guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
                  let data = item as? Data else { return nil }
            return String(data: data, encoding: .utf8)
        }
        set {
            let base: [String: Any] = [
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: service,
                kSecAttrAccount as String: account,
            ]
            SecItemDelete(base as CFDictionary)
            guard let value = newValue, let data = value.data(using: .utf8) else { return }
            var add = base
            add[kSecValueData as String] = data
            // Only readable while the phone is unlocked, and never restored to
            // a different device from a backup.
            add[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
            SecItemAdd(add as CFDictionary, nil)
        }
    }

    var isConfigured: Bool { endpoint != nil && token != nil }
}
