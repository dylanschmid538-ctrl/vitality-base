import Foundation
import HealthKit

/// Reads HealthKit and pushes it to the dashboard.
///
/// The app deliberately knows NOTHING about which metrics exist. It asks
/// `GET /api/health/config`, and collects whatever comes back. Adding HRV or
/// fibre later is a line in `lib/server/healthMetrics.ts` and a web deploy —
/// this app never needs rebuilding, re-signing and re-installing for it.
/// That asymmetry (a `git push` versus an Xcode round trip) is the whole
/// reason the config lives on the server.
enum SyncError: LocalizedError {
    case healthUnavailable
    case notConfigured
    case http(Int)

    var errorDescription: String? {
        switch self {
        case .healthUnavailable: return "HealthKit ist auf diesem Gerät nicht verfügbar."
        case .notConfigured: return "Adresse oder Token fehlen."
        case .http(let code): return "Server antwortete mit \(code)."
        }
    }
}

/// One metric as the server describes it.
struct MetricSpec: Decodable {
    let key: String
    let type: String
    let unit: String
    let aggregate: String
    /// Sleep only: deep and REM are VALUES of sleep analysis, not separate types.
    let stage: String?
}

struct MetricConfig: Decodable {
    let version: Int
    let metrics: [MetricSpec]
}

/// What one push produced, for the status screen.
struct SyncResult {
    let date: String
    let accepted: [String]
    let rejected: [String]
}

@MainActor
final class HealthSync: ObservableObject {
    @Published var lastSync: Date?
    @Published var lastResult: SyncResult?
    @Published var lastError: String?
    @Published var busy = false

    private let store = HKHealthStore()
    private var cachedConfig: MetricConfig?

    // MARK: - Config

    private func config() async throws -> MetricConfig {
        if let cachedConfig { return cachedConfig }
        guard let url = AppConfig.shared.endpoint, let token = AppConfig.shared.token else {
            throw SyncError.notConfigured
        }
        var req = URLRequest(url: url.appendingPathComponent("api/health/config"))
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let (data, response) = try await URLSession.shared.data(for: req)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw SyncError.http((response as? HTTPURLResponse)?.statusCode ?? -1)
        }
        let decoded = try JSONDecoder().decode(MetricConfig.self, from: data)
        cachedConfig = decoded
        return decoded
    }

    /// Turn a server type string into the HealthKit object it names.
    private func sampleType(_ spec: MetricSpec) -> HKSampleType? {
        let id = spec.type
        if id == HKCategoryTypeIdentifier.sleepAnalysis.rawValue {
            return HKCategoryType.categoryType(forIdentifier: .sleepAnalysis)
        }
        return HKQuantityType.quantityType(forIdentifier: HKQuantityTypeIdentifier(rawValue: id))
    }

    // MARK: - Permissions

    /// Ask once for everything the config names. iOS shows the sheet only for
    /// types not yet decided, so calling this on every launch is harmless and
    /// means a NEW metric from the server gets its permission automatically.
    func requestAuthorization() async throws {
        guard HKHealthStore.isHealthDataAvailable() else { throw SyncError.healthUnavailable }
        let types = try await Set(config().metrics.compactMap(sampleType))
        try await store.requestAuthorization(toShare: [], read: types)
    }

    // MARK: - Reading

    /// HealthKit units are strings on the wire; map them to the real thing.
    private func unit(for spec: MetricSpec) -> HKUnit {
        switch spec.unit {
        case "kcal": return .kilocalorie()
        case "g": return .gram()
        case "l": return .liter()
        case "kg": return .gramUnit(with: .kilo)
        case "%": return .percent()
        case "ms": return .secondUnit(with: .milli)
        case "min": return .minute()
        case "count/min": return HKUnit.count().unitDivided(by: .minute())
        default: return .count()
        }
    }

    /// Sum the sleep segments for a stage. Deep/REM are category VALUES, so a
    /// stage filter is the only way to separate them — several segments per
    /// night is normal and they all add up.
    private func sleepHours(stage: String, from samples: [HKCategorySample]) -> Double {
        let wanted: Set<Int>
        switch stage {
        case "deep": wanted = [HKCategoryValueSleepAnalysis.asleepDeep.rawValue]
        case "rem": wanted = [HKCategoryValueSleepAnalysis.asleepREM.rawValue]
        case "core": wanted = [HKCategoryValueSleepAnalysis.asleepCore.rawValue]
        default:
            // "asleep" means every asleep flavour, but NOT inBed — lying awake
            // in bed is not sleep, and counting it inflates every night.
            wanted = [
                HKCategoryValueSleepAnalysis.asleepCore.rawValue,
                HKCategoryValueSleepAnalysis.asleepDeep.rawValue,
                HKCategoryValueSleepAnalysis.asleepREM.rawValue,
                HKCategoryValueSleepAnalysis.asleepUnspecified.rawValue,
            ]
        }
        let seconds = samples
            .filter { wanted.contains($0.value) }
            .reduce(0.0) { $0 + $1.endDate.timeIntervalSince($1.startDate) }
        return seconds / 3600
    }

    private func query(_ spec: MetricSpec, start: Date, end: Date) async -> Double? {
        guard let type = sampleType(spec) else { return nil }
        let predicate = HKQuery.predicateForSamples(withStart: start, end: end, options: .strictStartDate)

        if let categoryType = type as? HKCategoryType {
            let samples: [HKCategorySample] = await withCheckedContinuation { cont in
                let q = HKSampleQuery(sampleType: categoryType, predicate: predicate,
                                      limit: HKObjectQueryNoLimit, sortDescriptors: nil) { _, result, _ in
                    cont.resume(returning: (result as? [HKCategorySample]) ?? [])
                }
                store.execute(q)
            }
            guard !samples.isEmpty else { return nil }
            return sleepHours(stage: spec.stage ?? "asleep", from: samples)
        }

        guard let quantityType = type as? HKQuantityType else { return nil }
        let hkUnit = unit(for: spec)

        if spec.aggregate == "latest" {
            let sample: HKQuantitySample? = await withCheckedContinuation { cont in
                let sort = [NSSortDescriptor(key: HKSampleSortIdentifierEndDate, ascending: false)]
                let q = HKSampleQuery(sampleType: quantityType, predicate: predicate,
                                      limit: 1, sortDescriptors: sort) { _, result, _ in
                    cont.resume(returning: result?.first as? HKQuantitySample)
                }
                store.execute(q)
            }
            return sample?.quantity.doubleValue(for: hkUnit)
        }

        let option: HKStatisticsOptions = spec.aggregate == "avg" ? .discreteAverage : .cumulativeSum
        return await withCheckedContinuation { cont in
            let q = HKStatisticsQuery(quantityType: quantityType, quantitySamplePredicate: predicate,
                                      options: option) { _, stats, _ in
                let quantity = option == .discreteAverage ? stats?.averageQuantity() : stats?.sumQuantity()
                cont.resume(returning: quantity?.doubleValue(for: hkUnit))
            }
            store.execute(q)
        }
    }

    // MARK: - Push

    /// Collect one day and send it. `day` defaults to today.
    @discardableResult
    func sync(day: Date = Date()) async -> Bool {
        busy = true
        defer { busy = false }
        do {
            guard let base = AppConfig.shared.endpoint, let token = AppConfig.shared.token else {
                throw SyncError.notConfigured
            }
            let cfg = try await config()
            let cal = Calendar.current
            let start = cal.startOfDay(for: day)
            let end = cal.date(byAdding: .day, value: 1, to: start)!

            var metrics: [String: Double] = [:]
            for spec in cfg.metrics {
                if let value = await query(spec, start: start, end: end) {
                    metrics[spec.key] = value
                }
            }

            let formatter = DateFormatter()
            formatter.dateFormat = "yyyy-MM-dd"
            formatter.timeZone = .current
            let dateString = formatter.string(from: start)

            var req = URLRequest(url: base.appendingPathComponent("api/health"))
            req.httpMethod = "POST"
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONSerialization.data(
                withJSONObject: ["date": dateString, "metrics": metrics])

            let (data, response) = try await URLSession.shared.data(for: req)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                throw SyncError.http((response as? HTTPURLResponse)?.statusCode ?? -1)
            }
            let body = try JSONSerialization.jsonObject(with: data) as? [String: Any]
            lastResult = SyncResult(date: body?["date"] as? String ?? dateString,
                                    accepted: body?["accepted"] as? [String] ?? [],
                                    rejected: body?["rejected"] as? [String] ?? [])
            lastSync = Date()
            lastError = nil
            return true
        } catch {
            lastError = error.localizedDescription
            return false
        }
    }

    // MARK: - Background

    /// Wake the app whenever HealthKit gets new data of a watched type. This is
    /// the part a Shortcut or a PWA can never do — it is the only reason this
    /// app exists.
    func startObserving() async {
        guard let cfg = try? await config() else { return }
        for spec in cfg.metrics {
            guard let type = sampleType(spec) else { continue }
            let q = HKObserverQuery(sampleType: type, predicate: nil) { [weak self] _, completion, _ in
                Task { @MainActor in
                    await self?.sync()
                    // MUST be called or iOS stops delivering — a missed
                    // completion silently kills background sync for good.
                    completion()
                }
            }
            store.execute(q)
            try? await store.enableBackgroundDelivery(for: type, frequency: .hourly)
        }
    }
}
