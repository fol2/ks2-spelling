import Foundation
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

    private func assertProfilePicker(
        in application: XCUIApplication,
        verifyFormReachability: Bool
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

        guard verifyFormReachability else { return }
        let nickname = application.textFields["First name or nickname"]
        let webView = application.webViews.firstMatch
        for _ in 0..<12 where !nickname.isHittable {
            webView.swipeUp()
        }
        XCTAssertTrue(
            nickname.waitForExistence(timeout: 10),
            "The production learner name field did not appear."
        )
        XCTAssertTrue(nickname.isHittable, "The production learner form is not reachable.")
        assertContained(nickname, in: application)
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

        let application = installedApplication()
        XCUIDevice.shared.orientation = .portrait
        application.terminate()
        application.launch()

        XCTAssertTrue(
            waitForOrientation(application, landscape: false),
            "The large-text production application did not settle in portrait."
        )
        assertProfilePicker(in: application, verifyFormReachability: true)
        attachScreenshot(name: "c5-product-phone-large-text")
    }

    func testProductTabletLayouts() {
        continueAfterFailure = false

        let application = installedApplication()
        XCUIDevice.shared.orientation = .portrait
        application.terminate()
        application.launch()
        XCTAssertTrue(
            waitForOrientation(application, landscape: false),
            "The production tablet application did not settle in portrait."
        )
        assertProfilePicker(in: application, verifyFormReachability: true)
        attachScreenshot(name: "c5-product-tablet-portrait")

        application.terminate()
        XCUIDevice.shared.orientation = .landscapeLeft
        application.launch()
        XCTAssertTrue(
            waitForOrientation(application, landscape: true),
            "The production tablet application did not settle in landscape."
        )
        assertProfilePicker(in: application, verifyFormReachability: true)
        attachScreenshot(name: "c5-product-tablet-landscape")
        XCUIDevice.shared.orientation = .portrait
    }
}
