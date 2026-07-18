package uk.eugnel.ks2spelling;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.graphics.Rect;
import android.os.SystemClock;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.uiautomator.By;
import androidx.test.uiautomator.BySelector;
import androidx.test.uiautomator.UiDevice;
import androidx.test.uiautomator.UiObject2;
import androidx.test.uiautomator.Until;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class B4DevelopmentTest {
    private static final String PACKAGE_ID = "uk.eugnel.ks2spelling";
    private static final String KEYBOARD_PACKAGE = "com.google.android.inputmethod.latin";
    private static final long WAIT_TIMEOUT_MS = 10_000;
    private static final String[] FROZEN_ANSWERS = {
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
    };

    private UiDevice device;
    private Context context;

    @Before
    public void setUp() {
        device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation());
        context = InstrumentationRegistry.getInstrumentation().getTargetContext();
    }

    @After
    public void restoreRotation() throws Exception {
        device.unfreezeRotation();
    }

    private String evidencePrefix() {
        String prefix = InstrumentationRegistry.getArguments().getString(
            "b4EvidencePrefix",
            "default"
        );
        if (!prefix.matches("[a-z0-9-]+")) {
            throw new IllegalArgumentException("B4 evidence prefix is invalid.");
        }
        return prefix;
    }

    private static BySelector text(String value) {
        return By.pkg(PACKAGE_ID).text(value);
    }

    private static BySelector button(String value) {
        return By.pkg(PACKAGE_ID)
            .clazz("android.widget.Button")
            .text(value)
            .enabled(true);
    }

    private static BySelector spellingInput() {
        return By.pkg(PACKAGE_ID)
            .clazz("android.widget.EditText")
            .res("b4-spelling-input")
            .enabled(true);
    }

    private static BySelector progress() {
        return By.pkg(PACKAGE_ID).text(Pattern.compile("Card [1-5] of 5"));
    }

    private UiObject2 waitForNode(String label, BySelector selector) {
        UiObject2 node = device.wait(Until.findObject(selector), WAIT_TIMEOUT_MS);
        assertNotNull("Timed out waiting for " + label + ".", node);
        return node;
    }

    private void waitForAbsence(String label, BySelector selector) {
        assertTrue(
            "Timed out waiting for " + label + " to disappear.",
            device.wait(Until.gone(selector), WAIT_TIMEOUT_MS)
        );
    }

    private void launchApplication() throws Exception {
        String output = device.executeShellCommand(
            "am start -W -a android.intent.action.MAIN " +
            "-c android.intent.category.LAUNCHER " +
            "-n " + PACKAGE_ID + "/.MainActivity"
        );
        assertTrue("The B4 application did not launch.", output.contains("Status: ok"));
        waitForNode("the learner heading", text("Listen, type, learn"));
    }

    private UiObject2 tap(String label, BySelector selector) {
        UiObject2 node = waitForNode(label, selector);
        node.click();
        return node;
    }

    private void setAnswer(String answer) {
        UiObject2 input = tap("the spelling input", spellingInput());
        assertTrue(
            "The software keyboard did not open for the spelling input.",
            waitForKeyboard(true)
        );
        input.setText(answer);
    }

    private boolean keyboardVisible() {
        return device.hasObject(By.pkg(KEYBOARD_PACKAGE));
    }

    private boolean waitForKeyboard(boolean visible) {
        return device.wait(
            visible
                ? Until.hasObject(By.pkg(KEYBOARD_PACKAGE))
                : Until.gone(By.pkg(KEYBOARD_PACKAGE)),
            WAIT_TIMEOUT_MS
        );
    }

    private void dismissKeyboard() {
        if (!keyboardVisible()) return;
        assertTrue("The Android Back action was rejected.", device.pressBack());
        assertTrue("The software keyboard did not close.", waitForKeyboard(false));
    }

    private double submitAnswer(int index, boolean useEnter) {
        setAnswer(FROZEN_ANSWERS[index]);
        long started = SystemClock.elapsedRealtimeNanos();
        if (useEnter) {
            assertTrue("The Android Enter action was rejected.", device.pressEnter());
        } else {
            dismissKeyboard();
            tap("Submit", button("Submit"));
        }
        waitForNode("Continue after answer " + (index + 1), button("Continue"));
        double elapsedMs = (SystemClock.elapsedRealtimeNanos() - started) / 1_000_000.0;
        dismissKeyboard();
        tap("Continue", button("Continue"));
        if (index < FROZEN_ANSWERS.length - 1) {
            waitForNode("the next spelling input", spellingInput());
        }
        return elapsedMs;
    }

    private double interruptAudio(String control) throws Exception {
        long started = SystemClock.elapsedRealtimeNanos();
        tap(control, button(control));
        waitForNode("Audio playing", text("Audio playing"));
        double elapsedMs = (SystemClock.elapsedRealtimeNanos() - started) / 1_000_000.0;
        assertTrue("The Android Home action was rejected.", device.pressHome());
        launchApplication();
        waitForAbsence("Audio playing", text("Audio playing"));
        return elapsedMs;
    }

    private double minimumControlHeightDp() {
        float density = context.getResources().getDisplayMetrics().density;
        double minimum = Double.POSITIVE_INFINITY;
        for (UiObject2 node : new UiObject2[] {
            waitForNode("Replay", button("Replay")),
            waitForNode("Slow replay", button("Slow replay")),
            waitForNode("Submit", button("Submit")),
            waitForNode("the spelling input", spellingInput())
        }) {
            Rect bounds = node.getVisibleBounds();
            minimum = Math.min(minimum, bounds.height() / density);
        }
        return minimum;
    }

    private File evidenceFile(String phase) {
        return new File(context.getFilesDir(), "b4-" + evidencePrefix() + "-" + phase + ".json");
    }

    private void writeEvidence(String phase, JSONObject value) throws Exception {
        try (FileOutputStream stream = new FileOutputStream(evidenceFile(phase), false)) {
            stream.write((value.toString(2) + "\n").getBytes(StandardCharsets.UTF_8));
        }
    }

    private JSONObject readEvidence(String phase) throws Exception {
        File file = evidenceFile(phase);
        byte[] bytes = new byte[(int) file.length()];
        try (FileInputStream stream = new FileInputStream(file)) {
            int offset = 0;
            while (offset < bytes.length) {
                int count = stream.read(bytes, offset, bytes.length - offset);
                if (count < 0) break;
                offset += count;
            }
            assertEquals("The phase evidence was truncated.", bytes.length, offset);
        }
        return new JSONObject(new String(bytes, StandardCharsets.UTF_8));
    }

    @Test
    public void testJourneyPhaseOne() throws Exception {
        long coldLaunchStarted = SystemClock.elapsedRealtimeNanos();
        launchApplication();
        double coldLaunchMs = (
            SystemClock.elapsedRealtimeNanos() - coldLaunchStarted
        ) / 1_000_000.0;

        double minimumControlHeightDp = minimumControlHeightDp();
        assertTrue("Android controls must be at least 48 dp.", minimumControlHeightDp >= 48);
        List<Double> audioStartMs = new ArrayList<>();
        audioStartMs.add(interruptAudio("Replay"));
        audioStartMs.add(interruptAudio("Slow replay"));

        tap("the spelling input", spellingInput());
        boolean softwareKeyboardObserved = waitForKeyboard(true);
        assertTrue("The Android software keyboard did not appear.", softwareKeyboardObserved);

        JSONArray answerFeedbackMs = new JSONArray();
        for (int index = 0; index < 3; index += 1) {
            answerFeedbackMs.put(submitAnswer(index, index == 0));
        }
        String resumeProgress = waitForNode("committed progress", progress()).getText();
        JSONObject evidence = new JSONObject()
            .put("schemaVersion", 1)
            .put("coldLaunchMs", coldLaunchMs)
            .put("audioStartMs", new JSONArray(audioStartMs))
            .put("answerFeedbackMs", answerFeedbackMs)
            .put("minimumControlHeightDp", minimumControlHeightDp)
            .put("softwareKeyboardObserved", softwareKeyboardObserved)
            .put("enterSubmitted", true)
            .put("backgroundAudioStoppedCount", 2)
            .put("resumeProgress", resumeProgress);
        writeEvidence("phase1", evidence);
    }

    @Test
    public void testJourneyPhaseTwo() throws Exception {
        JSONObject phaseOne = readEvidence("phase1");
        launchApplication();
        String resumedProgress = waitForNode("resumed progress", progress()).getText();
        assertEquals(
            "The exact committed round progress did not survive process death.",
            phaseOne.getString("resumeProgress"),
            resumedProgress
        );

        JSONArray answerFeedbackMs = new JSONArray();
        for (int index = 3; index < FROZEN_ANSWERS.length; index += 1) {
            answerFeedbackMs.put(submitAnswer(index, false));
        }
        waitForNode("Round complete", text("Round complete"));
        assertFalse("The round must complete only once.", device.hasObject(button("Continue")));
        writeEvidence("phase2", new JSONObject()
            .put("schemaVersion", 1)
            .put("answerFeedbackMs", answerFeedbackMs)
            .put("resumeProgressBefore", phaseOne.getString("resumeProgress"))
            .put("resumeProgressAfter", resumedProgress)
            .put("completed", true));
    }

    @Test
    public void testTabletLayout() throws Exception {
        device.setOrientationNatural();
        launchApplication();
        double naturalMinimumDp = minimumControlHeightDp();
        assertTrue("Tablet natural controls must be at least 48 dp.", naturalMinimumDp >= 48);

        device.setOrientationLeft();
        waitForNode("the rotated learner heading", text("Listen, type, learn"));
        double rotatedMinimumDp = minimumControlHeightDp();
        assertTrue("Tablet rotated controls must be at least 48 dp.", rotatedMinimumDp >= 48);
        writeEvidence("layout", new JSONObject()
            .put("schemaVersion", 1)
            .put("naturalMinimumControlHeightDp", naturalMinimumDp)
            .put("rotatedMinimumControlHeightDp", rotatedMinimumDp));
    }
}
