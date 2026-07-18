import XCTest

final class B3ProofScreenshotTests: XCTestCase {
    @MainActor
    func testCaptureInstalledApplication() throws {
        continueAfterFailure = false

        let application = XCUIApplication(
            bundleIdentifier: "uk.eugnel.ks2spelling"
        )
        application.activate()
        XCTAssertTrue(
            application.wait(for: .runningForeground, timeout: 15),
            "The exact installed B3 application did not reach the foreground."
        )

        let attachment = XCTAttachment(
            screenshot: XCUIScreen.main.screenshot(),
            quality: .original
        )
        attachment.name = "b3-ios-sandbox-proof.png"
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
