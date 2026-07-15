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

    @Test public void normalisationRejectsUnknownProductsAndUnspecifiedStates() {
        assertThrows(
            IllegalArgumentException.class,
            () -> CommercePlugin.normalisePurchaseSnapshot(
                Purchase.PurchaseState.UNSPECIFIED_STATE,
                false,
                List.of("full_ks2"),
                "token"
            )
        );
        assertThrows(
            IllegalArgumentException.class,
            () -> CommercePlugin.normalisePurchaseSnapshot(
                Purchase.PurchaseState.PURCHASED,
                true,
                List.of("foreign_product"),
                "token"
            )
        );
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
}
