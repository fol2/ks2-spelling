package uk.eugnel.ks2spelling;

import android.app.Activity;
import com.android.billingclient.api.BillingClient;
import com.android.billingclient.api.BillingClientStateListener;
import com.android.billingclient.api.BillingFlowParams;
import com.android.billingclient.api.BillingResult;
import com.android.billingclient.api.PendingPurchasesParams;
import com.android.billingclient.api.ProductDetails;
import com.android.billingclient.api.Purchase;
import com.android.billingclient.api.PurchasesUpdatedListener;
import com.android.billingclient.api.QueryProductDetailsParams;
import com.android.billingclient.api.QueryProductDetailsResult;
import com.android.billingclient.api.QueryPurchasesParams;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Pattern;
import org.json.JSONException;

@CapacitorPlugin(name = "Commerce")
public final class CommercePlugin extends Plugin implements PurchasesUpdatedListener, BillingClientStateListener {
    private static final String APPLE_PRODUCT_ID = "uk.eugnel.ks2spelling.fullks2";
    private static final String GOOGLE_PRODUCT_ID = "full_ks2";
    private static final String STORE_NATIVE_FAILURE = "STORE_NATIVE_FAILURE";
    private static final String STORE_COMPLETION_PENDING = "STORE_COMPLETION_PENDING";
    private static final int MAX_PROOF_CHARS = 65_536;
    private static final Pattern TRANSACTION_REFERENCE = Pattern.compile(
        "^google-play-token-sha256-[0-9a-f]{64}$"
    );

    private final Object stateLock = new Object();
    private final List<ReadyOperation> pendingReadyOperations = new ArrayList<>();
    private BillingClient billingClient;
    private boolean connecting;
    private boolean destroyed;
    private PluginCall pendingPurchaseCall;

    @Override public void load() {
        billingClient = BillingClient.newBuilder(getContext())
            .setListener(this)
            .enablePendingPurchases(
                PendingPurchasesParams.newBuilder()
                    .enableOneTimeProducts()
                    .build()
            )
            .enableAutoServiceReconnection()
            .build();
        ensureConnection();
    }

    @PluginMethod public void queryProducts(PluginCall call) {
        List<String> productIds = requireProductIds(call);
        if (productIds == null) return;
        if (!productIds.contains(GOOGLE_PRODUCT_ID)) {
            resolveProducts(call, Collections.emptyList());
            return;
        }
        withReady(call, () -> queryProductDetails(call, false));
    }

    @PluginMethod public void purchase(PluginCall call) {
        if (!exactKeys(call, Collections.singleton("productId"))) {
            reject(call);
            return;
        }
        String productId = call.getString("productId");
        if (!GOOGLE_PRODUCT_ID.equals(productId)) {
            reject(call);
            return;
        }
        withReady(call, () -> queryProductDetails(call, true));
    }

    @PluginMethod public void queryTransactions(PluginCall call) {
        List<String> productIds = requireProductIds(call);
        if (productIds == null) return;
        if (!productIds.contains(GOOGLE_PRODUCT_ID)) {
            resolveTransactions(call, Collections.emptyList());
            return;
        }
        withReady(call, () -> queryPurchases(call, false));
    }

    @PluginMethod public void restore(PluginCall call) {
        List<String> productIds = requireProductIds(call);
        if (productIds == null) return;
        if (!productIds.contains(GOOGLE_PRODUCT_ID)) {
            resolveTransactions(call, Collections.emptyList());
            return;
        }
        withReady(call, () -> queryPurchases(call, false));
    }

    @PluginMethod public void finishTransaction(PluginCall call) {
        if (!exactKeys(call, Collections.singleton("transactionRef"))) {
            reject(call);
            return;
        }
        String transactionRef = call.getString("transactionRef");
        if (transactionRef == null || !TRANSACTION_REFERENCE.matcher(transactionRef).matches()) {
            reject(call);
            return;
        }
        withReady(call, () -> queryPurchasesForCompletion(call, transactionRef));
    }

    @Override public void onBillingSetupFinished(BillingResult billingResult) {
        List<ReadyOperation> ready;
        synchronized (stateLock) {
            connecting = false;
            if (destroyed) return;
            ready = new ArrayList<>(pendingReadyOperations);
            pendingReadyOperations.clear();
        }
        if (!isOk(billingResult)) {
            for (ReadyOperation operation : ready) reject(operation.call);
            return;
        }
        queryPurchasesAsync(null, true);
        for (ReadyOperation operation : ready) operation.action.run();
    }

    @Override public void onBillingServiceDisconnected() {
        synchronized (stateLock) {
            connecting = false;
        }
    }

    @Override public void onPurchasesUpdated(BillingResult billingResult, List<Purchase> purchases) {
        PluginCall purchaseCall;
        synchronized (stateLock) {
            purchaseCall = pendingPurchaseCall;
            pendingPurchaseCall = null;
        }

        if (billingResult.getResponseCode() == BillingClient.BillingResponseCode.USER_CANCELED) {
            PurchaseSnapshot cancelled = transientSnapshot("cancelled");
            if (purchaseCall != null) purchaseCall.resolve(cancelled.javascriptObject());
            notifyListeners("transactionUpdated", cancelled.javascriptObject());
            return;
        }
        if (!isOk(billingResult) || purchases == null) {
            if (purchaseCall != null) reject(purchaseCall);
            return;
        }

        try {
            List<PurchaseSnapshot> snapshots = normalisePurchases(purchases);
            if (snapshots.size() != 1) throw new IllegalArgumentException();
            PurchaseSnapshot snapshot = snapshots.get(0);
            if (purchaseCall != null) purchaseCall.resolve(snapshot.javascriptObject());
            notifyListeners("transactionUpdated", snapshot.javascriptObject());
        } catch (RuntimeException error) {
            if (purchaseCall != null) reject(purchaseCall);
        }
    }

    @Override protected void handleOnResume() {
        super.handleOnResume();
        BillingClient client = billingClient;
        if (client != null && client.isReady()) queryPurchasesAsync(null, true);
        else ensureConnection();
    }

    @Override protected void handleOnDestroy() {
        List<ReadyOperation> waiting;
        PluginCall purchaseCall;
        BillingClient client;
        synchronized (stateLock) {
            destroyed = true;
            connecting = false;
            waiting = new ArrayList<>(pendingReadyOperations);
            pendingReadyOperations.clear();
            purchaseCall = pendingPurchaseCall;
            pendingPurchaseCall = null;
            client = billingClient;
        }
        for (ReadyOperation operation : waiting) reject(operation.call);
        if (purchaseCall != null) reject(purchaseCall);
        if (client != null) client.endConnection();
        super.handleOnDestroy();
    }

    private void queryProductDetails(PluginCall call, boolean launchAfterQuery) {
        QueryProductDetailsParams.Product product = QueryProductDetailsParams.Product.newBuilder()
            .setProductId(GOOGLE_PRODUCT_ID)
            .setProductType(BillingClient.ProductType.INAPP)
            .build();
        QueryProductDetailsParams params = QueryProductDetailsParams.newBuilder()
            .setProductList(Collections.singletonList(product))
            .build();
        billingClient.queryProductDetailsAsync(params, (result, detailsResult) -> {
            if (!isOk(result) || detailsResult == null) {
                reject(call);
                return;
            }
            try {
                List<ProductDetails> details = exactProductDetails(detailsResult);
                if (launchAfterQuery) {
                    if (details.size() != 1) reject(call);
                    else launchPurchase(call, details.get(0));
                } else {
                    resolveProducts(call, details);
                }
            } catch (RuntimeException error) {
                reject(call);
            }
        });
    }

    private void launchPurchase(PluginCall call, ProductDetails details) {
        getBridge().executeOnMainThread(() -> launchPurchaseOnMainThread(call, details));
    }

    private void launchPurchaseOnMainThread(PluginCall call, ProductDetails details) {
        Activity activity = getActivity();
        if (activity == null || !GOOGLE_PRODUCT_ID.equals(details.getProductId())) {
            reject(call);
            return;
        }
        boolean unavailable;
        synchronized (stateLock) {
            unavailable = destroyed || pendingPurchaseCall != null;
            if (!unavailable) pendingPurchaseCall = call;
        }
        if (unavailable) {
            reject(call);
            return;
        }
        BillingFlowParams.ProductDetailsParams product = BillingFlowParams.ProductDetailsParams
            .newBuilder()
            .setProductDetails(details)
            .build();
        BillingFlowParams params = BillingFlowParams.newBuilder()
            .setProductDetailsParamsList(Collections.singletonList(product))
            .build();
        BillingResult result;
        try {
            result = billingClient.launchBillingFlow(activity, params);
        } catch (RuntimeException error) {
            clearPendingPurchase(call);
            reject(call);
            return;
        }
        if (result.getResponseCode() == BillingClient.BillingResponseCode.USER_CANCELED) {
            clearPendingPurchase(call);
            PurchaseSnapshot cancelled = transientSnapshot("cancelled");
            call.resolve(cancelled.javascriptObject());
            return;
        }
        if (!isOk(result)) {
            clearPendingPurchase(call);
            reject(call);
        }
    }

    private void queryPurchases(PluginCall call, boolean emit) {
        queryPurchasesAsync((result, purchases) -> {
            if (!isOk(result) || purchases == null) {
                reject(call);
                return;
            }
            try {
                List<PurchaseSnapshot> snapshots = normalisePurchases(purchases);
                resolveTransactions(call, snapshots);
                if (emit) emitSnapshots(snapshots);
            } catch (RuntimeException error) {
                reject(call);
            }
        }, false);
    }

    private void queryPurchasesForCompletion(PluginCall call, String transactionRef) {
        queryPurchasesAsync((result, purchases) -> {
            if (!isOk(result) || purchases == null) {
                reject(call);
                return;
            }
            boolean found = false;
            boolean acknowledged = false;
            try {
                for (Purchase purchase : purchases) {
                    if (!isExactProductPurchase(purchase)) continue;
                    PurchaseSnapshot snapshot = normalisePurchaseSnapshot(
                        purchase.getPurchaseState(),
                        purchase.isAcknowledged(),
                        purchase.getProducts(),
                        purchase.getPurchaseToken()
                    );
                    if (snapshot.transactionRef().equals(transactionRef)) {
                        found = snapshot.outcome().equals("purchased");
                        acknowledged = snapshot.isAcknowledged();
                    }
                }
                completionForRequeriedPurchase(found, acknowledged);
                JSObject response = new JSObject();
                response.put("completion", "finished");
                call.resolve(response);
            } catch (StoreCompletionPendingException error) {
                JSObject response = new JSObject();
                response.put("completion", "pending");
                call.resolve(response);
            } catch (RuntimeException error) {
                reject(call);
            }
        }, false);
    }

    private void queryPurchasesAsync(PurchaseQuery listener, boolean emit) {
        QueryPurchasesParams params = QueryPurchasesParams.newBuilder()
            .setProductType(BillingClient.ProductType.INAPP)
            .build();
        billingClient.queryPurchasesAsync(params, (result, purchases) -> {
            if (listener != null) listener.complete(result, purchases);
            if (!emit || !isOk(result) || purchases == null) return;
            try {
                emitSnapshots(normalisePurchases(purchases));
            } catch (RuntimeException ignored) {
                // A malformed or unexpected store record is never exposed to JavaScript.
            }
        });
    }

    private List<ProductDetails> exactProductDetails(QueryProductDetailsResult result) {
        List<ProductDetails> details = result.getProductDetailsList();
        if (details == null || details.size() > 1) throw new IllegalArgumentException();
        for (ProductDetails entry : details) {
            if (!GOOGLE_PRODUCT_ID.equals(entry.getProductId()) ||
                !BillingClient.ProductType.INAPP.equals(entry.getProductType()) ||
                entry.getOneTimePurchaseOfferDetails() == null) {
                throw new IllegalArgumentException();
            }
        }
        return details;
    }

    private List<PurchaseSnapshot> normalisePurchases(List<Purchase> purchases) {
        List<PurchaseSnapshot> snapshots = new ArrayList<>();
        Set<String> references = new HashSet<>();
        for (Purchase purchase : purchases) {
            if (!isExactProductPurchase(purchase)) continue;
            PurchaseSnapshot snapshot = normalisePurchaseSnapshot(
                purchase.getPurchaseState(),
                purchase.isAcknowledged(),
                purchase.getProducts(),
                purchase.getPurchaseToken()
            );
            if (!references.add(snapshot.transactionRef())) throw new IllegalArgumentException();
            snapshots.add(snapshot);
        }
        snapshots.sort((left, right) -> left.transactionRef().compareTo(right.transactionRef()));
        return snapshots;
    }

    private boolean isExactProductPurchase(Purchase purchase) {
        return purchase != null && purchase.getProducts() != null &&
            purchase.getProducts().contains(GOOGLE_PRODUCT_ID);
    }

    private void resolveProducts(PluginCall call, List<ProductDetails> details) {
        JSArray products = new JSArray();
        for (ProductDetails entry : details) {
            ProductDetails.OneTimePurchaseOfferDetails offer = entry.getOneTimePurchaseOfferDetails();
            if (offer == null || offer.getPriceCurrencyCode() == null ||
                !offer.getPriceCurrencyCode().matches("^[A-Z]{3}$") ||
                !validText(entry.getName(), 256) ||
                !validText(entry.getDescription(), 1_024) ||
                !validText(offer.getFormattedPrice(), 64)) {
                reject(call);
                return;
            }
            JSObject product = new JSObject();
            product.put("productId", entry.getProductId());
            product.put("displayName", entry.getName());
            product.put("description", entry.getDescription());
            product.put("displayPrice", offer.getFormattedPrice());
            product.put("currencyCode", offer.getPriceCurrencyCode());
            products.put(product);
        }
        JSObject response = new JSObject();
        response.put("products", products);
        call.resolve(response);
    }

    private void resolveTransactions(PluginCall call, List<PurchaseSnapshot> snapshots) {
        JSArray transactions = new JSArray();
        for (PurchaseSnapshot snapshot : snapshots) transactions.put(snapshot.javascriptObject());
        JSObject response = new JSObject();
        response.put("transactions", transactions);
        call.resolve(response);
    }

    private void emitSnapshots(List<PurchaseSnapshot> snapshots) {
        for (PurchaseSnapshot snapshot : snapshots) {
            notifyListeners("transactionUpdated", snapshot.javascriptObject());
        }
    }

    private List<String> requireProductIds(PluginCall call) {
        if (!exactKeys(call, Collections.singleton("productIds"))) {
            reject(call);
            return null;
        }
        JSArray values = call.getArray("productIds");
        if (values == null || values.length() < 1 || values.length() > 2) {
            reject(call);
            return null;
        }
        List<String> output = new ArrayList<>();
        Set<String> unique = new HashSet<>();
        try {
            for (int index = 0; index < values.length(); index += 1) {
                String value = values.getString(index);
                if ((!APPLE_PRODUCT_ID.equals(value) && !GOOGLE_PRODUCT_ID.equals(value)) ||
                    !unique.add(value)) {
                    reject(call);
                    return null;
                }
                output.add(value);
            }
        } catch (JSONException error) {
            reject(call);
            return null;
        }
        return output;
    }

    private boolean exactKeys(PluginCall call, Set<String> expected) {
        Set<String> actual = new HashSet<>();
        Iterator<String> keys = call.getData().keys();
        while (keys.hasNext()) {
            if (!actual.add(keys.next())) return false;
        }
        return actual.equals(expected);
    }

    private void withReady(PluginCall call, Runnable action) {
        boolean rejectCall;
        boolean runNow;
        synchronized (stateLock) {
            rejectCall = destroyed;
            runNow = !destroyed && billingClient != null && billingClient.isReady();
            if (!rejectCall && !runNow) {
                pendingReadyOperations.add(new ReadyOperation(call, action));
            }
        }
        if (rejectCall) {
            reject(call);
            return;
        }
        if (runNow) {
            action.run();
            return;
        }
        ensureConnection();
    }

    private void ensureConnection() {
        BillingClient client;
        synchronized (stateLock) {
            if (destroyed || connecting || billingClient == null || billingClient.isReady()) return;
            connecting = true;
            client = billingClient;
        }
        try {
            client.startConnection(this);
        } catch (RuntimeException error) {
            List<ReadyOperation> waiting;
            synchronized (stateLock) {
                connecting = false;
                waiting = new ArrayList<>(pendingReadyOperations);
                pendingReadyOperations.clear();
            }
            for (ReadyOperation operation : waiting) reject(operation.call);
        }
    }

    private void clearPendingPurchase(PluginCall expected) {
        synchronized (stateLock) {
            if (pendingPurchaseCall == expected) pendingPurchaseCall = null;
        }
    }

    private void reject(PluginCall call) {
        call.reject("Store operation rejected.", STORE_NATIVE_FAILURE);
    }

    private static boolean isOk(BillingResult result) {
        return result != null && result.getResponseCode() == BillingClient.BillingResponseCode.OK;
    }

    private static boolean validText(String value, int maxLength) {
        return value != null && !value.isEmpty() && value.length() <= maxLength && value.indexOf('\0') < 0;
    }

    static PurchaseSnapshot normalisePurchaseSnapshot(
        int state,
        boolean acknowledged,
        List<String> products,
        String token
    ) {
        if (products == null || products.size() != 1 || !GOOGLE_PRODUCT_ID.equals(products.get(0)) ||
            token == null || token.isEmpty() || token.length() > MAX_PROOF_CHARS || token.indexOf('\0') >= 0) {
            throw new IllegalArgumentException();
        }
        String outcome;
        String proof;
        if (state == Purchase.PurchaseState.PURCHASED) {
            outcome = "purchased";
            proof = token;
        } else if (state == Purchase.PurchaseState.PENDING) {
            outcome = "pending";
            proof = null;
        } else {
            throw new IllegalArgumentException();
        }
        return new PurchaseSnapshot(
            GOOGLE_PRODUCT_ID,
            outcome,
            referenceForToken(token),
            proof,
            acknowledged
        );
    }

    static String completionForRequeriedPurchase(boolean found, boolean acknowledged) {
        if (!found || !acknowledged) throw new StoreCompletionPendingException();
        return "finished";
    }

    private static PurchaseSnapshot transientSnapshot(String outcome) {
        return new PurchaseSnapshot(
            GOOGLE_PRODUCT_ID,
            outcome,
            "google-play-transient-" + UUID.randomUUID().toString().toLowerCase(),
            null,
            false
        );
    }

    private static String referenceForToken(String token) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256")
                .digest(token.getBytes(StandardCharsets.UTF_8));
            StringBuilder output = new StringBuilder("google-play-token-sha256-");
            for (byte value : digest) output.append(String.format("%02x", value & 0xff));
            return output.toString();
        } catch (NoSuchAlgorithmException error) {
            throw new IllegalStateException(error);
        }
    }

    static final class PurchaseSnapshot {
        private final String productId;
        private final String outcome;
        private final String transactionRef;
        private final String opaqueProof;
        private final boolean acknowledged;

        PurchaseSnapshot(
            String productId,
            String outcome,
            String transactionRef,
            String opaqueProof,
            boolean acknowledged
        ) {
            this.productId = productId;
            this.outcome = outcome;
            this.transactionRef = transactionRef;
            this.opaqueProof = opaqueProof;
            this.acknowledged = acknowledged;
        }

        String store() { return "google"; }
        String environment() { return "sandbox"; }
        String productId() { return productId; }
        String outcome() { return outcome; }
        String transactionRef() { return transactionRef; }
        String opaqueProof() { return opaqueProof; }
        boolean isAcknowledged() { return acknowledged; }

        JSObject javascriptObject() {
            JSObject value = new JSObject();
            value.put("store", store());
            value.put("environment", environment());
            value.put("productId", productId);
            value.put("outcome", outcome);
            value.put("transactionRef", transactionRef);
            if (opaqueProof != null) value.put("opaqueProof", opaqueProof);
            return value;
        }
    }

    static final class StoreCompletionPendingException extends RuntimeException {
        String safeCode() { return STORE_COMPLETION_PENDING; }
    }

    private static final class ReadyOperation {
        final PluginCall call;
        final Runnable action;

        ReadyOperation(PluginCall call, Runnable action) {
            this.call = call;
            this.action = action;
        }
    }

    @FunctionalInterface
    private interface PurchaseQuery {
        void complete(BillingResult result, List<Purchase> purchases);
    }
}
