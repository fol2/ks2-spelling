import Foundation
import XCTest

@MainActor
final class B4DevelopmentTests: XCTestCase {
    private let frozenAnswers = [
        "arrive",
        "answer",
        "arrive",
        "appear",
        "bicycle",
        "appear",
        "build",
        "bicycle",
        "build",
        "answer"
    ]

    private struct JourneyObservations: Encodable {
        let schemaVersion = 1
        let coldLaunchMs: Double
        let answerFeedbackMs: [Double]
        let audioStartMs: [Double]
        let minimumControlHeightPoints: Double
        let referenceTextHeightPoints: Double
        let softwareKeyboardObserved: Bool
        let enterSubmitted: Bool
        let backgroundAudioStoppedCount: Int
        let resumeProgressBefore: String
        let resumeProgressAfter: String
        let completed: Bool
    }

    private struct SplitTimingObservation: Encodable {
        let answerIndex: Int
        let expectedRevision: Int
        let submitEpochMs: Double
        let audioPlayingVisibleEpochMs: Double
        let feedbackVisibleEpochMs: Double
        let replayToAudioPlayingVisibleMs: Double
    }

    private struct SplitTimingObservations: Encodable {
        let schemaVersion = 1
        let clock = "Unix epoch milliseconds"
        let observations: [SplitTimingObservation]
        let completed: Bool
    }

    private func installedApplication() -> XCUIApplication {
        XCUIApplication(bundleIdentifier: "uk.eugnel.ks2spelling")
    }

    private func waitUntilEnabled(
        _ element: XCUIElement,
        timeout: TimeInterval = 10
    ) -> Bool {
        if element.exists && element.isEnabled { return true }
        let expectation = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "exists == true AND enabled == true"),
            object: element
        )
        return XCTWaiter.wait(for: [expectation], timeout: timeout) == .completed
    }

    private func waitUntilAbsent(
        _ element: XCUIElement,
        timeout: TimeInterval = 5
    ) -> Bool {
        if !element.exists { return true }
        let expectation = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "exists == false"),
            object: element
        )
        return XCTWaiter.wait(for: [expectation], timeout: timeout) == .completed
    }

    private func waitUntilPresent(
        _ element: XCUIElement,
        timeout: TimeInterval = 10
    ) -> Bool {
        if element.exists { return true }
        return element.waitForExistence(timeout: timeout)
    }

    private func focusForTyping(
        _ input: XCUIElement,
        in application: XCUIApplication
    ) -> Bool {
        let keyboard = application.keyboards.firstMatch
        input.tap()
        guard input.wait(for: \.hasFocus, toEqual: true, timeout: 5) else {
            return false
        }
        return keyboard.waitForExistence(timeout: 5)
    }

    private func elapsedMilliseconds(since start: Date) -> Double {
        Date().timeIntervalSince(start) * 1_000
    }

    private func epochMilliseconds() -> Double {
        Date().timeIntervalSince1970 * 1_000
    }

    private func waitForFeedbackObservingAudio(
        audioPlaying: XCUIElement,
        continueButton: XCUIElement,
        timeout: TimeInterval = 10
    ) -> (audioEpochMs: Double, feedbackEpochMs: Double)? {
        // A correct-answer submission renders feedback without an audio cue, so
        // feedback is the required event; audio visibility is recorded only if
        // it happens to appear first, using -1 as the explicit absent marker.
        let deadline = Date().addingTimeInterval(timeout)
        var audioEpochMs: Double = -1
        while Date() < deadline {
            if audioEpochMs < 0 && audioPlaying.exists {
                audioEpochMs = epochMilliseconds()
            }
            if continueButton.exists {
                return (audioEpochMs, epochMilliseconds())
            }
            RunLoop.current.run(until: Date().addingTimeInterval(0.002))
        }
        return nil
    }

    private func progressLabel(in application: XCUIApplication) -> XCUIElement {
        application.staticTexts.matching(
            NSPredicate(format: "label MATCHES %@", "Card [1-5] of 5")
        ).firstMatch
    }

    private func attachJSON<T: Encodable>(_ value: T, name: String) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let attachment = XCTAttachment(
            data: try encoder.encode(value),
            uniformTypeIdentifier: "public.json"
        )
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func attachScreenshot(name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func revealCompletionForScreenshot(in application: XCUIApplication) {
        let freshRound = application.buttons["Start a fresh round"]
        let webView = application.webViews.firstMatch
        for _ in 0..<8 where !freshRound.isHittable {
            webView.swipeUp()
        }
        XCTAssertTrue(
            freshRound.isHittable,
            "The completion action was not visible for the evidence screenshot."
        )
    }

    private func waitForWindowOrientation(
        _ application: XCUIApplication,
        landscape: Bool,
        timeout: TimeInterval = 10
    ) -> Bool {
        let predicate = NSPredicate { object, _ in
            guard let element = object as? XCUIElement else { return false }
            return landscape
                ? element.frame.width > element.frame.height
                : element.frame.height > element.frame.width
        }
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: application)
        return XCTWaiter.wait(for: [expectation], timeout: timeout) == .completed
    }

    func testLearnerSurfaceAppears() throws {
        continueAfterFailure = false

        let application = installedApplication()
        application.activate()

        XCTAssertTrue(
            application.staticTexts["Listen, type, learn"].waitForExistence(timeout: 10),
            "The installed B4 learner surface did not appear."
        )
    }

    func testInstalledFiveCardJourney() throws {
        continueAfterFailure = false

        let application = installedApplication()
        application.terminate()
        let coldLaunchStart = Date()
        application.launch()

        let heading = application.staticTexts["Listen, type, learn"]
        XCTAssertTrue(
            waitUntilPresent(heading),
            "The cold-launched learner surface did not appear."
        )
        let coldLaunchMs = elapsedMilliseconds(since: coldLaunchStart)

        let input = application.textFields["Type the spelling"]
        let replay = application.buttons["Replay"]
        let slowReplay = application.buttons["Slow replay"]
        let submit = application.buttons["Submit"]
        let referenceText = application.staticTexts["Type the spelling"]
        XCTAssertTrue(waitUntilEnabled(input), "The spelling input did not become ready.")
        XCTAssertTrue(waitUntilEnabled(replay), "Replay did not become ready.")
        XCTAssertTrue(waitUntilEnabled(slowReplay), "Slow replay did not become ready.")
        XCTAssertTrue(waitUntilEnabled(submit), "Submit did not become ready.")
        XCTAssertTrue(
            waitUntilPresent(referenceText),
            "The text-scale reference label did not become ready."
        )

        let minimumControlHeightPoints = [input, replay, slowReplay, submit]
            .map(\.frame.height)
            .min() ?? 0
        XCTAssertGreaterThanOrEqual(
            minimumControlHeightPoints,
            44,
            "Every iOS learner control must be at least 44 points high."
        )
        let referenceTextHeightPoints = referenceText.frame.height
        XCTAssertGreaterThan(
            referenceTextHeightPoints,
            0,
            "The text-scale reference label must have a measurable height."
        )

        var audioStartMs: [Double] = []
        var backgroundAudioStoppedCount = 0
        let audioPlaying = application.staticTexts["Audio playing"]
        for control in [replay, slowReplay] {
            XCTAssertTrue(waitUntilAbsent(audioPlaying), "Playback state was not idle before replay.")
            let audioStart = Date()
            control.tap()
            XCTAssertTrue(
                // A wide window separates slow starts (recorded honestly as a
                // large audioStartMs figure) from genuine stalls (still fail).
                waitUntilPresent(audioPlaying, timeout: 30),
                "Local playback did not reach the visible playing state."
            )
            audioStartMs.append(elapsedMilliseconds(since: audioStart))

            XCUIDevice.shared.press(.home)
            application.activate()
            XCTAssertTrue(
                waitUntilPresent(heading),
                "The learner surface did not foreground after audio interruption."
            )
            XCTAssertTrue(
                waitUntilAbsent(audioPlaying),
                "Backgrounding must stop playback and clear its visible state."
            )
            backgroundAudioStoppedCount += 1
        }

        var answerFeedbackMs: [Double] = []
        var softwareKeyboardObserved = false
        var enterSubmitted = false
        var resumeProgressBefore = ""
        var resumeProgressAfter = ""

        for (index, answer) in frozenAnswers.enumerated() {
            XCTAssertTrue(waitUntilEnabled(input), "The spelling input was unavailable for answer \(index + 1).")
            XCTAssertTrue(
                focusForTyping(input, in: application),
                "The spelling input did not acquire software-keyboard focus for answer \(index + 1)."
            )
            if index == 0 {
                softwareKeyboardObserved = true
            }
            input.typeText(answer)

            let feedbackStart = Date()
            if index == 0 {
                input.typeText("\n")
                enterSubmitted = true
            } else {
                application.buttons["Submit"].tap()
            }

            let continueButton = application.buttons["Continue"]
            XCTAssertTrue(
                waitUntilPresent(continueButton),
                "Rendered feedback did not appear for answer \(index + 1)."
            )
            answerFeedbackMs.append(elapsedMilliseconds(since: feedbackStart))
            continueButton.tap()

            if index == frozenAnswers.count - 1 {
                XCTAssertTrue(
                    waitUntilPresent(application.staticTexts["Round complete"]),
                    "The five-card round did not complete exactly once."
                )
                continue
            }

            XCTAssertTrue(waitUntilEnabled(input), "The next spelling prompt did not become ready.")
            if index == 2 {
                let progressBefore = progressLabel(in: application)
                XCTAssertTrue(waitUntilPresent(progressBefore, timeout: 5), "Progress was unavailable before relaunch.")
                resumeProgressBefore = progressBefore.label

                application.terminate()
                application.launch()
                XCTAssertTrue(
                    waitUntilPresent(heading),
                    "The learner surface did not return after process relaunch."
                )
                XCTAssertTrue(waitUntilEnabled(input), "The resumed spelling prompt did not become ready.")
                let progressAfter = progressLabel(in: application)
                XCTAssertTrue(waitUntilPresent(progressAfter, timeout: 5), "Progress was unavailable after relaunch.")
                resumeProgressAfter = progressAfter.label
                XCTAssertEqual(
                    resumeProgressAfter,
                    resumeProgressBefore,
                    "The exact committed round progress must survive process relaunch."
                )
            }
        }

        XCTAssertEqual(answerFeedbackMs.count, 10)
        XCTAssertEqual(audioStartMs.count, 2)
        XCTAssertEqual(backgroundAudioStoppedCount, 2)
        XCTAssertFalse(resumeProgressBefore.isEmpty)
        XCTAssertTrue(enterSubmitted)

        try attachJSON(
            JourneyObservations(
                coldLaunchMs: coldLaunchMs,
                answerFeedbackMs: answerFeedbackMs,
                audioStartMs: audioStartMs,
                minimumControlHeightPoints: minimumControlHeightPoints,
                referenceTextHeightPoints: referenceTextHeightPoints,
                softwareKeyboardObserved: softwareKeyboardObserved,
                enterSubmitted: enterSubmitted,
                backgroundAudioStoppedCount: backgroundAudioStoppedCount,
                resumeProgressBefore: resumeProgressBefore,
                resumeProgressAfter: resumeProgressAfter,
                completed: true
            ),
            name: "b4-ios-journey-observations.json"
        )

        revealCompletionForScreenshot(in: application)
        attachScreenshot(name: "b4-ios-completed-round")
    }

    func testSplitTimingJourney() throws {
        continueAfterFailure = false

        let application = installedApplication()
        application.terminate()
        application.launch()

        let heading = application.staticTexts["Listen, type, learn"]
        let input = application.textFields["Type the spelling"]
        let replay = application.buttons["Replay"]
        let audioPlaying = application.staticTexts["Audio playing"]
        XCTAssertTrue(waitUntilPresent(heading), "The split-timing learner surface did not appear.")

        var observations: [SplitTimingObservation] = []
        for (index, answer) in frozenAnswers.enumerated() {
            XCUIDevice.shared.press(.home)
            application.activate()
            XCTAssertTrue(waitUntilPresent(heading), "The learner surface did not foreground.")
            XCTAssertTrue(waitUntilAbsent(audioPlaying), "Foregrounding did not clear playback.")
            XCTAssertTrue(waitUntilEnabled(replay), "Replay was unavailable for answer \(index + 1).")
            let replayStarted = Date()
            replay.tap()
            XCTAssertTrue(
                waitUntilPresent(audioPlaying),
                "Replay did not expose the playing state for answer \(index + 1)."
            )
            let replayToAudioPlayingVisibleMs = elapsedMilliseconds(since: replayStarted)

            XCUIDevice.shared.press(.home)
            application.activate()
            XCTAssertTrue(waitUntilPresent(heading), "The learner surface did not foreground.")
            XCTAssertTrue(waitUntilAbsent(audioPlaying), "Foregrounding did not clear playback.")

            XCTAssertTrue(waitUntilEnabled(input), "The spelling input was unavailable.")
            XCTAssertTrue(
                focusForTyping(input, in: application),
                "The spelling input did not acquire keyboard focus."
            )
            input.typeText(answer)

            let submitEpochMs = epochMilliseconds()
            application.buttons["Submit"].tap()
            let continueButton = application.buttons["Continue"]
            guard let visible = waitForFeedbackObservingAudio(
                audioPlaying: audioPlaying,
                continueButton: continueButton
            ) else {
                XCTFail("Feedback was not externally visible for answer \(index + 1).")
                return
            }
            observations.append(SplitTimingObservation(
                answerIndex: index + 1,
                expectedRevision: 2 + (index * 2),
                submitEpochMs: submitEpochMs,
                audioPlayingVisibleEpochMs: visible.audioEpochMs,
                feedbackVisibleEpochMs: visible.feedbackEpochMs,
                replayToAudioPlayingVisibleMs: replayToAudioPlayingVisibleMs
            ))

            continueButton.tap()
            if index == frozenAnswers.count - 1 {
                XCTAssertTrue(waitUntilPresent(application.staticTexts["Round complete"]))
            } else {
                XCTAssertTrue(waitUntilEnabled(input), "The next spelling prompt did not become ready.")
            }
        }

        XCTAssertEqual(observations.count, frozenAnswers.count)
        try attachJSON(
            SplitTimingObservations(observations: observations, completed: true),
            name: "b4-ios-split-timing.json"
        )
    }

    func testTabletLayoutScreenshots() throws {
        continueAfterFailure = false

        let application = installedApplication()
        XCUIDevice.shared.orientation = .portrait
        application.terminate()
        application.launch()

        let heading = application.staticTexts["Listen, type, learn"]
        let input = application.textFields["Type the spelling"]
        let replay = application.buttons["Replay"]
        let slowReplay = application.buttons["Slow replay"]
        let submit = application.buttons["Submit"]
        XCTAssertTrue(waitUntilPresent(heading), "The tablet portrait surface did not appear.")
        XCTAssertTrue(
            waitForWindowOrientation(application, landscape: false),
            "The tablet application window did not settle in portrait."
        )
        for control in [input, replay, slowReplay, submit] {
            XCTAssertTrue(waitUntilEnabled(control), "A tablet portrait control was unreachable.")
            XCTAssertTrue(control.isHittable, "A tablet portrait control was not hittable.")
        }
        attachScreenshot(name: "b4-ios-layout-portrait")

        application.terminate()
        XCUIDevice.shared.orientation = .landscapeLeft
        application.launch()
        XCTAssertTrue(
            waitForWindowOrientation(application, landscape: true),
            "The tablet application window did not settle in landscape."
        )
        XCTAssertTrue(waitUntilPresent(heading), "The tablet landscape surface did not remain visible.")
        for control in [input, replay, slowReplay, submit] {
            XCTAssertTrue(waitUntilEnabled(control), "A tablet landscape control was unreachable.")
            XCTAssertTrue(control.isHittable, "A tablet landscape control was not hittable.")
        }
        attachScreenshot(name: "b4-ios-layout-landscape")
        XCUIDevice.shared.orientation = .portrait
    }
}
