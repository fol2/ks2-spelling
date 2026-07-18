package uk.eugnel.ks2spelling;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import android.accessibilityservice.AccessibilityServiceInfo;
import android.app.Instrumentation;
import android.app.UiAutomation;
import android.content.Context;
import android.graphics.Rect;
import android.os.Bundle;
import android.os.ParcelFileDescriptor;
import android.os.SystemClock;
import android.view.InputDevice;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class B4DevelopmentTest {
    private static final String PACKAGE_ID = "uk.eugnel.ks2spelling";
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

    private interface NodeMatcher {
        boolean matches(AccessibilityNodeInfo node);
    }

    private Instrumentation instrumentation;
    private UiAutomation automation;
    private Context context;

    @Before
    public void setUp() {
        instrumentation = InstrumentationRegistry.getInstrumentation();
        automation = instrumentation.getUiAutomation();
        AccessibilityServiceInfo serviceInfo = automation.getServiceInfo();
        serviceInfo.flags |= AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS;
        automation.setServiceInfo(serviceInfo);
        context = instrumentation.getTargetContext();
    }

    @After
    public void restoreRotation() {
        automation.setRotation(UiAutomation.ROTATION_UNFREEZE);
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

    private AccessibilityNodeInfo findNode(NodeMatcher matcher) {
        AccessibilityNodeInfo root = automation.getRootInActiveWindow();
        if (root == null) return null;
        ArrayDeque<AccessibilityNodeInfo> pending = new ArrayDeque<>();
        pending.add(root);
        while (!pending.isEmpty()) {
            AccessibilityNodeInfo node = pending.removeFirst();
            if (matcher.matches(node)) return node;
            for (int index = 0; index < node.getChildCount(); index += 1) {
                AccessibilityNodeInfo child = node.getChild(index);
                if (child != null) pending.addLast(child);
            }
        }
        return null;
    }

    private AccessibilityNodeInfo waitForNode(String label, NodeMatcher matcher) {
        long deadline = SystemClock.uptimeMillis() + WAIT_TIMEOUT_MS;
        AccessibilityNodeInfo node;
        while (SystemClock.uptimeMillis() < deadline) {
            node = findNode(matcher);
            if (node != null) return node;
            SystemClock.sleep(50);
        }
        fail("Timed out waiting for " + label + ".");
        return null;
    }

    private void waitForAbsence(String label, NodeMatcher matcher) {
        long deadline = SystemClock.uptimeMillis() + WAIT_TIMEOUT_MS;
        while (SystemClock.uptimeMillis() < deadline) {
            if (findNode(matcher) == null) return;
            SystemClock.sleep(50);
        }
        fail("Timed out waiting for " + label + " to disappear.");
    }

    private static boolean exactText(AccessibilityNodeInfo node, String value) {
        return node.getText() != null && value.contentEquals(node.getText());
    }

    private static NodeMatcher text(String value) {
        return node -> exactText(node, value);
    }

    private static NodeMatcher button(String value) {
        return node -> exactText(node, value) &&
            "android.widget.Button".contentEquals(node.getClassName()) &&
            node.isEnabled();
    }

    private static NodeMatcher spellingInput() {
        return node -> "b4-spelling-input".equals(node.getViewIdResourceName()) &&
            "android.widget.EditText".contentEquals(node.getClassName()) &&
            node.isEnabled();
    }

    private static NodeMatcher progress() {
        return node -> node.getText() != null &&
            node.getText().toString().matches("Card [1-5] of 5");
    }

    private void launchApplication() throws Exception {
        shell(
            "am start -W -a android.intent.action.MAIN " +
            "-c android.intent.category.LAUNCHER " +
            "-n " + PACKAGE_ID + "/.MainActivity"
        );
        instrumentation.waitForIdleSync();
        waitForNode("the learner heading", text("Listen, type, learn"));
    }

    private void shell(String command) throws Exception {
        try (
            ParcelFileDescriptor descriptor = automation.executeShellCommand(command);
            FileInputStream stream = new FileInputStream(descriptor.getFileDescriptor())
        ) {
            byte[] buffer = new byte[4_096];
            while (stream.read(buffer) >= 0) {
                // Reading to EOF waits for the shell command to complete.
            }
        }
    }

    private void click(AccessibilityNodeInfo node, String label) {
        Rect bounds = new Rect();
        node.getBoundsInScreen(bounds);
        assertFalse(label + " had empty screen bounds.", bounds.isEmpty());
        float x = bounds.exactCenterX();
        float y = bounds.exactCenterY();
        long started = SystemClock.uptimeMillis();
        MotionEvent down = MotionEvent.obtain(
            started,
            started,
            MotionEvent.ACTION_DOWN,
            x,
            y,
            0
        );
        MotionEvent up = MotionEvent.obtain(
            started,
            started + 50,
            MotionEvent.ACTION_UP,
            x,
            y,
            0
        );
        down.setSource(InputDevice.SOURCE_TOUCHSCREEN);
        up.setSource(InputDevice.SOURCE_TOUCHSCREEN);
        try {
            assertTrue(label + " touch-down was rejected.", automation.injectInputEvent(down, true));
            assertTrue(label + " touch-up was rejected.", automation.injectInputEvent(up, true));
        } finally {
            down.recycle();
            up.recycle();
        }
    }

    private void setAnswer(String answer) {
        AccessibilityNodeInfo input = waitForNode("the spelling input", spellingInput());
        click(input, "The spelling input");
        Bundle arguments = new Bundle();
        arguments.putCharSequence(
            AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE,
            answer
        );
        assertTrue(
            "The spelling input rejected text.",
            input.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, arguments)
        );
    }

    private boolean waitForSoftwareKeyboard() {
        long deadline = SystemClock.uptimeMillis() + WAIT_TIMEOUT_MS;
        while (SystemClock.uptimeMillis() < deadline) {
            for (AccessibilityWindowInfo window : automation.getWindows()) {
                if (window.getType() == AccessibilityWindowInfo.TYPE_INPUT_METHOD) return true;
            }
            SystemClock.sleep(50);
        }
        return false;
    }

    private void pressEnter() {
        long now = SystemClock.uptimeMillis();
        assertTrue(automation.injectInputEvent(new KeyEvent(
            now,
            now,
            KeyEvent.ACTION_DOWN,
            KeyEvent.KEYCODE_ENTER,
            0
        ), true));
        assertTrue(automation.injectInputEvent(new KeyEvent(
            now,
            SystemClock.uptimeMillis(),
            KeyEvent.ACTION_UP,
            KeyEvent.KEYCODE_ENTER,
            0
        ), true));
    }

    private double submitAnswer(int index, boolean useEnter) {
        setAnswer(FROZEN_ANSWERS[index]);
        long started = SystemClock.elapsedRealtimeNanos();
        if (useEnter) pressEnter();
        else click(waitForNode("Submit", button("Submit")), "Submit");
        AccessibilityNodeInfo continueButton = waitForNode("Continue", button("Continue"));
        double elapsedMs = (SystemClock.elapsedRealtimeNanos() - started) / 1_000_000.0;
        click(continueButton, "Continue");
        if (index < FROZEN_ANSWERS.length - 1) {
            waitForNode("the next spelling input", spellingInput());
        }
        return elapsedMs;
    }

    private double interruptAudio(String control) throws Exception {
        long started = SystemClock.elapsedRealtimeNanos();
        click(waitForNode(control, button(control)), control);
        waitForNode("Audio playing", text("Audio playing"));
        double elapsedMs = (SystemClock.elapsedRealtimeNanos() - started) / 1_000_000.0;
        shell("input keyevent KEYCODE_HOME");
        launchApplication();
        waitForAbsence("Audio playing", text("Audio playing"));
        return elapsedMs;
    }

    private double minimumControlHeightDp() {
        float density = context.getResources().getDisplayMetrics().density;
        double minimum = Double.POSITIVE_INFINITY;
        for (AccessibilityNodeInfo node : new AccessibilityNodeInfo[] {
            waitForNode("Replay", button("Replay")),
            waitForNode("Slow replay", button("Slow replay")),
            waitForNode("Submit", button("Submit")),
            waitForNode("the spelling input", spellingInput())
        }) {
            Rect bounds = new Rect();
            node.getBoundsInScreen(bounds);
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

        AccessibilityNodeInfo input = waitForNode("the spelling input", spellingInput());
        click(input, "The spelling input");
        boolean softwareKeyboardObserved = waitForSoftwareKeyboard();
        assertTrue("The Android software keyboard did not appear.", softwareKeyboardObserved);

        JSONArray answerFeedbackMs = new JSONArray();
        for (int index = 0; index < 3; index += 1) {
            answerFeedbackMs.put(submitAnswer(index, index == 0));
        }
        String resumeProgress = waitForNode("committed progress", progress()).getText().toString();
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
        String resumedProgress = waitForNode("resumed progress", progress()).getText().toString();
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
        assertFalse("The round must complete only once.", findNode(button("Continue")) != null);
        writeEvidence("phase2", new JSONObject()
            .put("schemaVersion", 1)
            .put("answerFeedbackMs", answerFeedbackMs)
            .put("resumeProgressBefore", phaseOne.getString("resumeProgress"))
            .put("resumeProgressAfter", resumedProgress)
            .put("completed", true));
    }

    @Test
    public void testTabletLayout() throws Exception {
        automation.setRotation(UiAutomation.ROTATION_FREEZE_0);
        launchApplication();
        double portraitMinimumDp = minimumControlHeightDp();
        assertTrue("Tablet portrait controls must be at least 48 dp.", portraitMinimumDp >= 48);

        automation.setRotation(UiAutomation.ROTATION_FREEZE_90);
        waitForNode("the landscape learner heading", text("Listen, type, learn"));
        double landscapeMinimumDp = minimumControlHeightDp();
        assertTrue("Tablet landscape controls must be at least 48 dp.", landscapeMinimumDp >= 48);
        writeEvidence("layout", new JSONObject()
            .put("schemaVersion", 1)
            .put("portraitMinimumControlHeightDp", portraitMinimumDp)
            .put("landscapeMinimumControlHeightDp", landscapeMinimumDp));
    }
}
