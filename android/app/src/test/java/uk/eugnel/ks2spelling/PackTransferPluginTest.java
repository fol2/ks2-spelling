package uk.eugnel.ks2spelling;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.fail;

import java.util.Arrays;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import java.net.HttpURLConnection;
import java.net.URL;
import org.junit.Test;

public final class PackTransferPluginTest {
    private static final String CAP = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    private static final String VALID = "https://b3-gateway.eugnel.uk/v1/packs/"
        + "b3-sandbox-proof/1.0.0-b3.1/b3-sandbox-proof.zip"
        + "?expires=1783900800&cap=" + CAP;

    @Test public void rejectsCapabilityMutationsBeforeOpeningAConnection() throws Exception {
        List<String> mutations = Arrays.asList(
            VALID.replace("https:", "http:"),
            VALID.replace("b3-gateway.eugnel.uk", "evil.example"),
            VALID.replace("https://", "https://user:pass@"),
            VALID.replace(".uk/", ".uk:444/"),
            VALID + "#fragment",
            VALID + "&extra=1",
            VALID.replace("?expires=1783900800&cap=", "?cap=" + CAP + "&expires=1783900800&cap="),
            VALID.replace("expires=1783900800", "expires=01783900800"),
            VALID.replace("1.0.0-b3.1", "../1.0.0-b3.1"),
            VALID.replace("cap=" + CAP, "cap=" + CAP.substring(1))
        );
        for (String mutation : mutations) {
            AtomicInteger connections = new AtomicInteger();
            try {
                PackTransferPlugin.openValidatedCapability(
                    mutation, "b3-sandbox-proof", "1.0.0-b3.1", "b3-sandbox-proof.zip",
                    url -> { connections.incrementAndGet(); return null; }
                );
                fail("Accepted mutation " + mutation);
            } catch (Exception expected) {
                // Validation rejection is the contract.
            }
            assertEquals(0, connections.get());
        }
    }

    @Test public void exactCapabilityOpensOnlyAfterValidation() throws Exception {
        AtomicInteger connections = new AtomicInteger();
        PackTransferPlugin.openValidatedCapability(
            VALID, "b3-sandbox-proof", "1.0.0-b3.1", "b3-sandbox-proof.zip",
            url -> { connections.incrementAndGet(); return null; }
        );
        assertEquals(1, connections.get());
    }

    @Test public void exactNativeHeadersAndClosedSafeCodesMatchTheGatewayContract() throws Exception {
        HttpURLConnection connection = new StubConnection(new URL(VALID));
        PackTransferPlugin.configureConnection(connection, 4, 100);
        assertEquals("GET", connection.getRequestMethod());
        assertEquals(false, connection.getInstanceFollowRedirects());
        assertEquals("http://localhost", connection.getRequestProperty("Origin"));
        assertEquals("bytes=4-99", connection.getRequestProperty("Range"));
        assertEquals("identity", connection.getRequestProperty("Accept-Encoding"));
        assertEquals("PACK_CAPABILITY_EXPIRED", PackTransferPlugin.safeDownloadErrorCode(400, 4));
        assertEquals("PACK_RANGE_NOT_SATISFIABLE", PackTransferPlugin.safeDownloadErrorCode(416, 0));
        assertEquals(null, PackTransferPlugin.safeDownloadErrorCode(416, 1));
        assertEquals(null, PackTransferPlugin.safeDownloadErrorCode(403, 0));
    }

    @Test public void rangeBoundAppliesToChunkLengthNotAbsoluteOffset() throws Exception {
        HttpURLConnection connection = new StubConnection(new URL(VALID));
        PackTransferPlugin.configureConnection(connection, 2_000_000, 3_048_576);
        assertEquals("bytes=2000000-3048575", connection.getRequestProperty("Range"));

        try {
            PackTransferPlugin.configureConnection(
                new StubConnection(new URL(VALID)), 2_000_000, 3_048_577
            );
            fail("Accepted a range larger than the one MiB native chunk ceiling");
        } catch (Exception expected) {
            // Rejection is the contract.
        }
    }

    private static final class StubConnection extends HttpURLConnection {
        StubConnection(URL url) { super(url); }
        @Override public void disconnect() {}
        @Override public boolean usingProxy() { return false; }
        @Override public void connect() {}
    }
}
