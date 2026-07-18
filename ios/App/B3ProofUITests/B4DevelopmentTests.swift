import XCTest

final class B4DevelopmentTests: XCTestCase {
    @MainActor
    func testLearnerSurfaceAppears() throws {
        continueAfterFailure = false

        let application = XCUIApplication(
            bundleIdentifier: "uk.eugnel.ks2spelling"
        )
        application.activate()

        XCTAssertTrue(
            application.staticTexts["Listen, type, learn"].waitForExistence(timeout: 10),
            "The installed B4 learner surface did not appear."
        )
    }
}
