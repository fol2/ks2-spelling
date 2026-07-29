import Foundation
import UIKit
import XCTest

@MainActor
final class C5ProductLayoutTests: XCTestCase {
    private func installedApplication() -> XCUIApplication {
        XCUIApplication(bundleIdentifier: "uk.eugnel.ks2spelling")
    }

    private func waitForOrientation(
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
        let expectation = XCTNSPredicateExpectation(
            predicate: predicate,
            object: application
        )
        return XCTWaiter.wait(for: [expectation], timeout: timeout) == .completed
    }

    private func assertContained(
        _ element: XCUIElement,
        in application: XCUIApplication,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        let viewport = application.frame
        let frame = element.frame
        XCTAssertGreaterThanOrEqual(frame.minX, viewport.minX, file: file, line: line)
        XCTAssertGreaterThanOrEqual(frame.minY, viewport.minY, file: file, line: line)
        XCTAssertLessThanOrEqual(frame.maxX, viewport.maxX, file: file, line: line)
        XCTAssertLessThanOrEqual(frame.maxY, viewport.maxY, file: file, line: line)
    }

    @discardableResult
    private func reveal(
        _ element: XCUIElement,
        in application: XCUIApplication,
        message: String,
        swipeUp: Bool = true
    ) -> XCUIElement {
        XCTAssertTrue(element.waitForExistence(timeout: 10), message)
        let webView = application.webViews.firstMatch
        for _ in 0..<12 where !element.isHittable {
            if swipeUp {
                webView.swipeUp()
            } else {
                webView.swipeDown()
            }
        }
        XCTAssertTrue(element.isHittable, message)
        assertContained(element, in: application)
        return element
    }

    private func reachableNicknameField(
        in application: XCUIApplication
    ) -> XCUIElement {
        let nickname = application.textFields["First name or nickname"]
        if nickname.waitForExistence(timeout: 1) {
            return reveal(
                nickname,
                in: application,
                message: "The production learner name field is not reachable."
            )
        }

        let addLearner = application.buttons["Add a learner"]
        if !addLearner.waitForExistence(timeout: 2) {
            // The nickname smoke test is intended for a clean install, but a
            // reused device may launch on Trail. The learner chip remains the
            // first authored Trail button and opens the same switch sheet.
            let trailSetOff = application.buttons["Set off"]
            XCTAssertTrue(
                trailSetOff.waitForExistence(timeout: 5),
                "Neither the learner picker nor the Trail appeared."
            )
            let learnerChip = application.buttons.element(boundBy: 0)
            XCTAssertTrue(
                learnerChip.isHittable,
                "The existing learner switch action is not reachable."
            )
            learnerChip.tap()
        }

        reveal(
            addLearner,
            in: application,
            message: "The Add a learner action is not reachable."
        ).tap()
        return reveal(
            nickname,
            in: application,
            message: "The production learner name field did not appear."
        )
    }

    @discardableResult
    private func requireSoftwareLetterKeys(
        in application: XCUIApplication,
        timeout: TimeInterval = 5
    ) -> XCUIElement {
        let keyboard = application.keyboards.firstMatch
        XCTAssertTrue(
            keyboard.waitForExistence(timeout: timeout),
            "A real field tap did not promptly present a software keyboard."
        )

        // A keyboard container or the previous/next/done assistant strip alone
        // is not enough. The original device failure exposed those controls with
        // no usable key rows, so require an actual alphabet key before claiming
        // that software typing is available. Run physical-device probes with no
        // external hardware keyboard attached.
        let lowerA = keyboard.keys["a"]
        let upperA = keyboard.keys["A"]
        let hasLetterKey = lowerA.waitForExistence(timeout: 2)
            || upperA.waitForExistence(timeout: 1)
        XCTAssertTrue(
            hasLetterKey,
            "The input assistant appeared without usable software letter keys."
        )
        XCTAssertTrue(
            lowerA.exists ? lowerA.isHittable : upperA.isHittable,
            "The software letter row exists but is not hittable."
        )
        return keyboard
    }

    private func pressSubmissionKey(on keyboard: XCUIElement) {
        for label in ["done", "Done", "return", "Return", "go", "Go"] {
            let button = keyboard.buttons[label]
            if button.exists && button.isHittable {
                button.tap()
                return
            }
            let key = keyboard.keys[label]
            if key.exists && key.isHittable {
                key.tap()
                return
            }
        }
        XCTFail("The visible field keyboard has no usable submission key.")
    }

    private func openPracticeForKeyboardProbe(
        in application: XCUIApplication
    ) -> XCUIElement {
        let trailSetOff = application.buttons["Set off"]

        // Reuse a learner already on the device. The previous probe added one on
        // every run, eventually risking a full profile list that could no longer
        // reach Practice for the keyboard assertion.
        if !trailSetOff.waitForExistence(timeout: 2) {
            let existingLearner = application.buttons.matching(
                NSPredicate(format: "label CONTAINS[c] %@", "words a week")
            ).firstMatch
            if existingLearner.waitForExistence(timeout: 1) {
                reveal(
                    existingLearner,
                    in: application,
                    message: "An existing learner could not be selected."
                ).tap()
            }
        }

        if !trailSetOff.waitForExistence(timeout: 3) {
            let learnerName = "Keyboard runner \(Int(Date().timeIntervalSince1970))"
            let nickname = reachableNicknameField(in: application)
            nickname.tap()
            let profileKeyboard = requireSoftwareLetterKeys(in: application)
            nickname.typeText(learnerName)
            pressSubmissionKey(on: profileKeyboard)

            if !trailSetOff.waitForExistence(timeout: 5) {
                let addLearner = application.buttons["Add learner"]
                if addLearner.exists {
                    reveal(
                        addLearner,
                        in: application,
                        message: "The learner form could not be submitted."
                    ).tap()
                }
            }
            if !trailSetOff.waitForExistence(timeout: 10) {
                let learner = application.staticTexts[learnerName]
                reveal(
                    learner,
                    in: application,
                    message: "The newly created learner could not be selected."
                ).tap()
            }
        }

        reveal(
            trailSetOff,
            in: application,
            message: "The Trail Set off action did not appear."
        ).tap()

        XCTAssertTrue(
            application.staticTexts["Vocabulary set"].waitForExistence(timeout: 10),
            "The round setup screen did not appear."
        )
        let setupSetOff = application.buttons.matching(
            NSPredicate(format: "label BEGINSWITH %@", "Set off")
        ).firstMatch
        reveal(
            setupSetOff,
            in: application,
            message: "The setup Set off action is not reachable."
        ).tap()

        let labelled = application.textFields["Type the spelling"]
        let placeholder = application.textFields["your spelling"]
        let spelling = labelled.waitForExistence(timeout: 3)
            ? labelled
            : placeholder
        return reveal(
            spelling,
            in: application,
            message: "The actual visible Practice spelling field did not appear."
        )
    }

    private func assertProfilePicker(
        in application: XCUIApplication
    ) {
        let heading = application.staticTexts["Who is practising?"]
        let parentAction = application.buttons["For parents"]
        XCTAssertTrue(
            heading.waitForExistence(timeout: 10),
            "The production profile picker heading did not appear."
        )
        XCTAssertTrue(
            parentAction.waitForExistence(timeout: 10),
            "The production Parent action did not appear."
        )
        XCTAssertTrue(parentAction.isHittable, "The production Parent action is not reachable.")
        assertContained(parentAction, in: application)

        _ = reachableNicknameField(in: application)
        let webView = application.webViews.firstMatch
        for _ in 0..<12 where !heading.isHittable {
            webView.swipeDown()
        }
        XCTAssertTrue(heading.isHittable, "The profile heading could not be restored after scrolling.")
    }

    private func attachScreenshot(name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    func testProductLargeTextProfilePicker() {
        continueAfterFailure = false

        XCTAssertEqual(
            UIDevice.current.userInterfaceIdiom,
            .phone,
            "The large-text product proof requires an iPhone destination."
        )
        XCTAssertEqual(
            UIApplication.shared.preferredContentSizeCategory,
            .accessibilityExtraExtraExtraLarge,
            "The product proof requires the maximum accessibility text size."
        )
        let application = installedApplication()
        XCUIDevice.shared.orientation = .portrait
        application.terminate()
        application.launch()

        XCTAssertTrue(
            waitForOrientation(application, landscape: false),
            "The large-text production application did not settle in portrait."
        )
        assertProfilePicker(in: application)
        attachScreenshot(name: "c5-product-phone-large-text")
    }

    // Run this probe on a clean physical-device install as well as Simulator.
    // It deliberately taps and types into the actual visible WebView field; no
    // hidden proxy, programmatic focus or keyboard plugin participates.
    func testProductNicknameFieldRaisesSoftwareKeyboard() {
        continueAfterFailure = false

        XCTAssertEqual(
            UIDevice.current.userInterfaceIdiom,
            .phone,
            "The software-keyboard probe requires an iPhone destination."
        )
        let application = installedApplication()
        XCUIDevice.shared.orientation = .portrait
        application.terminate()
        application.launch()

        XCTAssertTrue(
            waitForOrientation(application, landscape: false),
            "The keyboard-probe application did not settle in portrait."
        )
        let nickname = reachableNicknameField(in: application)
        nickname.tap()
        _ = requireSoftwareLetterKeys(in: application)

        nickname.typeText("Keyboard guard")
        XCTAssertEqual(
            nickname.value as? String,
            "Keyboard guard",
            "Typed text did not remain owned by the visible nickname field."
        )
        attachScreenshot(name: "c5-product-visible-field-keyboard")
    }

    func testProductPracticeFieldKeepsSoftwareKeyboardAcrossReturn() {
        continueAfterFailure = false

        XCTAssertEqual(
            UIDevice.current.userInterfaceIdiom,
            .phone,
            "The Practice keyboard probe requires an iPhone destination."
        )
        let application = installedApplication()
        XCUIDevice.shared.orientation = .portrait
        application.terminate()
        application.launch()

        XCTAssertTrue(
            waitForOrientation(application, landscape: false),
            "The Practice keyboard-probe application did not settle in portrait."
        )
        let spelling = openPracticeForKeyboardProbe(in: application)
        spelling.tap()
        let keyboard = requireSoftwareLetterKeys(in: application)
        spelling.typeText("zzzzzz")
        XCTAssertEqual(spelling.value as? String, "zzzzzz")
        pressSubmissionKey(on: keyboard)

        let answerWasProcessed = XCTNSPredicateExpectation(
            predicate: NSPredicate { object, _ in
                guard let field = object as? XCUIElement else { return false }
                return (field.value as? String) != "zzzzzz"
            },
            object: spelling
        )
        XCTAssertEqual(
            XCTWaiter.wait(for: [answerWasProcessed], timeout: 10),
            .completed,
            "The Return submission did not finish."
        )

        // Feedback deliberately keeps the same field focused but rejects edits.
        // Require real software letter rows during that lock, not only the input
        // assistant strip, and prove an attempted edit cannot change the value.
        let feedbackKeyboard = application.keyboards.firstMatch
        XCTAssertTrue(
            feedbackKeyboard.exists,
            "The software keyboard disappeared while feedback locked edits."
        )
        let feedbackLowerA = feedbackKeyboard.keys["a"]
        let feedbackUpperA = feedbackKeyboard.keys["A"]
        XCTAssertTrue(
            (feedbackLowerA.exists && feedbackLowerA.isHittable)
                || (feedbackUpperA.exists && feedbackUpperA.isHittable),
            "Feedback left only the input assistant without software letter rows."
        )
        let lockedValue = spelling.value as? String
        spelling.typeText("x")
        XCTAssertEqual(
            spelling.value as? String,
            lockedValue,
            "The feedback lock accepted an edit before the next card."
        )

        // Wait for the product's real two-second auto-advance. Only then should
        // the next card accept another spelling through the same keyboard session.
        XCTAssertTrue(
            application.buttons["Submit"].waitForExistence(timeout: 10),
            "The next card did not appear after the feedback interval."
        )
        _ = requireSoftwareLetterKeys(in: application)
        spelling.typeText("a")
        XCTAssertEqual(
            spelling.value as? String,
            "a",
            "The next card did not retain the same visible keyboard session."
        )
        attachScreenshot(name: "c5-product-practice-return-keyboard")
    }

    func testProductTabletLayouts() {
        continueAfterFailure = false

        XCTAssertEqual(
            UIDevice.current.userInterfaceIdiom,
            .pad,
            "The tablet product proof requires an iPad destination."
        )
        let application = installedApplication()
        XCUIDevice.shared.orientation = .portrait
        application.terminate()
        application.launch()
        XCTAssertTrue(
            waitForOrientation(application, landscape: false),
            "The production tablet application did not settle in portrait."
        )
        assertProfilePicker(in: application)
        attachScreenshot(name: "c5-product-tablet-portrait")

        application.terminate()
        XCUIDevice.shared.orientation = .landscapeLeft
        application.launch()
        XCTAssertTrue(
            waitForOrientation(application, landscape: true),
            "The production tablet application did not settle in landscape."
        )
        assertProfilePicker(in: application)
        attachScreenshot(name: "c5-product-tablet-landscape")
        XCUIDevice.shared.orientation = .portrait
    }
}
