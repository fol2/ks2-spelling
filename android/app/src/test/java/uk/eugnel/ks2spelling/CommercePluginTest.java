package uk.eugnel.ks2spelling;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import com.android.billingclient.api.Purchase;
import java.util.List;
import org.junit.Test;

public final class CommercePluginTest {
    @Test public void purchasedSnapshotCarriesTheTokenOnlyAsOpaqueProof() {
        String token = "sandbox-purchase-token";
        CommercePlugin.PurchaseSnapshot snapshot = CommercePlugin.normalisePurchaseSnapshot(
            Purchase.PurchaseState.PURCHASED,
            false,
            List.of("full_ks2"),
            token
        );

        assertEquals("google", snapshot.store());
        assertEquals("sandbox", snapshot.environment());
        assertEquals("full_ks2", snapshot.productId());
        assertEquals("purchased", snapshot.outcome());
        assertEquals(token, snapshot.opaqueProof());
        assertFalse(snapshot.isAcknowledged());
        assertTrue(snapshot.transactionRef().startsWith("google-play-token-sha256-"));
        assertFalse(snapshot.transactionRef().contains(token));
    }

    @Test public void pendingSnapshotHasNoProofAndCannotGrantAccess() {
        CommercePlugin.PurchaseSnapshot snapshot = CommercePlugin.normalisePurchaseSnapshot(
            Purchase.PurchaseState.PENDING,
            false,
            List.of("full_ks2"),
            "pending-token"
        );

        assertEquals("pending", snapshot.outcome());
        assertNull(snapshot.opaqueProof());
        assertFalse(snapshot.isAcknowledged());
    }

    @Test public void normalisationRejectsMalformedProductsAndUnspecifiedStates() {
        assertThrows(
            IllegalArgumentException.class,
            () -> CommercePlugin.normalisePurchaseSnapshot(
                Purchase.PurchaseState.UNSPECIFIED_STATE,
                false,
                List.of("full_ks2"),
                "token"
            )
        );
        // An Apple-shaped id, an uppercase id, and a multi-product purchase all
        // violate the Google product identity shape the bridge fails closed on;
        // exact catalogue membership is enforced in the application layer.
        for (List<String> products : List.of(
            List.of("uk.eugnel.ks2spelling.fullks2"),
            List.of("FULL_KS2"),
            List.of("full_ks2", "second_product"),
            List.<String>of()
        )) {
            assertThrows(
                IllegalArgumentException.class,
                () -> CommercePlugin.normalisePurchaseSnapshot(
                    Purchase.PurchaseState.PURCHASED,
                    true,
                    products,
                    "token"
                )
            );
        }
    }

    @Test public void completionRequiresTheRequeriedPurchaseToBeAcknowledged() {
        assertEquals("finished", CommercePlugin.completionForRequeriedPurchase(true, true));
        for (boolean[] state : List.of(
            new boolean[] { false, false },
            new boolean[] { true, false },
            new boolean[] { false, true }
        )) {
            CommercePlugin.StoreCompletionPendingException error = assertThrows(
                CommercePlugin.StoreCompletionPendingException.class,
                () -> CommercePlugin.completionForRequeriedPurchase(state[0], state[1])
            );
            assertEquals("STORE_COMPLETION_PENDING", error.safeCode());
        }
    }

    @Test public void successfulResumeQuerySettlesARecoveredPendingPurchase() {
        CommercePlugin.PurchaseSnapshot purchased = CommercePlugin.normalisePurchaseSnapshot(
            Purchase.PurchaseState.PURCHASED,
            false,
            List.of("full_ks2"),
            "recovered-purchase-token"
        );

        assertEquals(
            purchased,
            CommercePlugin.pendingSnapshotForSuccessfulQuery(List.of(purchased), "full_ks2")
        );
        CommercePlugin.PurchaseSnapshot cancelled =
            CommercePlugin.pendingSnapshotForSuccessfulQuery(List.of(), "full_ks2");
        assertEquals("cancelled", cancelled.outcome());
        assertNull(cancelled.opaqueProof());

        // A purchase of a different catalogue product cannot settle this call.
        CommercePlugin.PurchaseSnapshot otherProduct =
            CommercePlugin.pendingSnapshotForSuccessfulQuery(List.of(purchased), "other_pack");
        assertEquals("cancelled", otherProduct.outcome());
        assertEquals("other_pack", otherProduct.productId());
    }

    @Test public void ambiguousResumeQueryCannotSettleAPendingPurchase() {
        CommercePlugin.PurchaseSnapshot first = CommercePlugin.normalisePurchaseSnapshot(
            Purchase.PurchaseState.PURCHASED,
            false,
            List.of("full_ks2"),
            "first-token"
        );
        CommercePlugin.PurchaseSnapshot second = CommercePlugin.normalisePurchaseSnapshot(
            Purchase.PurchaseState.PENDING,
            false,
            List.of("full_ks2"),
            "second-token"
        );
        assertThrows(
            IllegalArgumentException.class,
            () -> CommercePlugin.pendingSnapshotForSuccessfulQuery(
                List.of(first, second),
                "full_ks2"
            )
        );
    }
}
