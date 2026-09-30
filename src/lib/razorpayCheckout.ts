// Razorpay Checkout Modal Client SDK Integration
// Supports Google Pay, PhonePe, Paytm, UPI Intent, Cards, & NetBanking.

export interface RazorpayCheckoutOptions {
  keyId: string;
  orderId: string;
  amount: number; // in paise
  currency?: string;
  name?: string;
  description?: string;
  customerName?: string;
  customerPhone?: string;
  customerEmail?: string;
  isLive?: boolean;
  onSuccess: (response: {
    razorpay_payment_id: string;
    razorpay_order_id: string;
    razorpay_signature?: string;
  }) => void;
  onError?: (error: unknown) => void;
  onDismiss?: () => void;
}

interface RazorpayInstance {
  open: () => void;
}

declare global {
  interface Window {
    Razorpay?: new (options: unknown) => RazorpayInstance;
  }
}

/**
 * Loads the Razorpay checkout.js script asynchronously.
 */
export function loadRazorpayScript(): Promise<boolean> {
  return new Promise((resolve) => {
    if (typeof window === "undefined") {
      resolve(false);
      return;
    }

    if (window.Razorpay) {
      resolve(true);
      return;
    }

    const script = document.createElement("script");
    script.src = "https://checkout.razorpay.com/v1/checkout.js";
    script.async = true;
    script.onload = () => resolve(true);
    script.onerror = () => {
      console.warn("Failed to load official Razorpay script. Test simulator will be used.");
      resolve(false);
    };
    document.body.appendChild(script);
  });
}

/**
 * In-App Interactive Test Payment Gateway Modal for Demo & Development Mode.
 * Triggers when live merchant credentials are not configured in production.
 */
function openSimulationCheckoutModal(options: RazorpayCheckoutOptions): void {
  if (typeof document === "undefined") {
    options.onSuccess({
      razorpay_payment_id: `pay_sim_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      razorpay_order_id: options.orderId,
      razorpay_signature: "simulated_test_sig",
    });
    return;
  }

  const existing = document.getElementById("brew-simulated-payment-modal");
  if (existing) existing.remove();

  const formattedAmount = (options.amount / 100).toFixed(2);
  const container = document.createElement("div");
  container.id = "brew-simulated-payment-modal";
  container.style.cssText = `
    position: fixed;
    inset: 0;
    z-index: 999999;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(10, 6, 4, 0.85);
    backdrop-filter: blur(8px);
    padding: 16px;
    font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  `;

  container.innerHTML = `
    <div style="
      background: linear-gradient(145deg, #1A130E, #231B15);
      border: 1px solid rgba(223, 171, 108, 0.35);
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.8), 0 0 30px rgba(223, 171, 108, 0.15);
      border-radius: 20px;
      max-width: 440px;
      width: 100%;
      overflow: hidden;
      animation: modalFadeIn 0.25s ease-out;
      color: #FAF7F2;
    ">
      <style>
        @keyframes modalFadeIn {
          from { opacity: 0; transform: scale(0.95) translateY(8px); }
          to { opacity: 1; transform: scale(1) translateY(0); }
        }
        .sim-btn-pay:hover {
          background: linear-gradient(135deg, #DFAB6C, #C88C50) !important;
          transform: translateY(-1px);
        }
        .sim-method-opt:hover {
          border-color: #DFAB6C !important;
          background: rgba(223, 171, 108, 0.12) !important;
        }
      </style>

      <!-- Header -->
      <div style="padding: 20px 24px; border-bottom: 1px solid rgba(255,255,255,0.08); display: flex; align-items: center; justify-content: space-between;">
        <div style="display: flex; align-items: center; gap: 10px;">
          <div style="width: 36px; height: 36px; border-radius: 10px; background: rgba(223, 171, 108, 0.15); display: flex; align-items: center; justify-content: center; font-size: 18px;">
            ☕
          </div>
          <div>
            <div style="font-weight: 700; font-size: 16px; letter-spacing: -0.01em;">BREW Instant Gateway</div>
            <div style="font-size: 11px; color: #DFAB6C; font-weight: 600; letter-spacing: 0.05em;">TEST SIMULATOR (DEV & DEMO)</div>
          </div>
        </div>
        <button id="sim-close-btn" style="background: transparent; border: none; color: #A89F91; font-size: 24px; cursor: pointer; padding: 4px; line-height: 1;">&times;</button>
      </div>

      <!-- Amount Section -->
      <div style="padding: 24px; text-align: center; background: rgba(0,0,0,0.25); border-bottom: 1px solid rgba(255,255,255,0.06);">
        <div style="font-size: 11px; color: #A89F91; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 6px;">Total Payable Amount</div>
        <div style="font-size: 38px; font-weight: 800; color: #FAF7F2; font-family: ui-monospace, monospace;">₹${formattedAmount}</div>
        <div style="font-size: 12px; color: #DFAB6C; margin-top: 4px; font-mono">Order #${options.orderId.replace(/^order_test_|^order_/, "").slice(0, 8)}</div>
      </div>

      <!-- Payment Methods -->
      <div style="padding: 20px 24px;">
        <div style="font-size: 12px; color: #A89F91; margin-bottom: 12px; font-weight: 500;">Select Demo Payment Instrument:</div>
        
        <label class="sim-method-opt" style="display: flex; align-items: center; gap: 12px; padding: 12px 14px; border: 1px solid rgba(223, 171, 108, 0.4); background: rgba(223, 171, 108, 0.08); border-radius: 12px; cursor: pointer; margin-bottom: 10px; transition: all 0.2s;">
          <input type="radio" name="sim-method" value="upi" checked style="accent-color: #DFAB6C;">
          <div>
            <div style="font-size: 14px; font-weight: 600;">⚡ Instant UPI Simulation</div>
            <div style="font-size: 11px; color: #A89F91;">Google Pay, PhonePe, Paytm, BHIM</div>
          </div>
        </label>

        <label class="sim-method-opt" style="display: flex; align-items: center; gap: 12px; padding: 12px 14px; border: 1px solid rgba(255, 255, 255, 0.1); background: rgba(255, 255, 255, 0.03); border-radius: 12px; cursor: pointer; margin-bottom: 10px; transition: all 0.2s;">
          <input type="radio" name="sim-method" value="card" style="accent-color: #DFAB6C;">
          <div>
            <div style="font-size: 14px; font-weight: 600;">💳 Test Debit / Credit Card</div>
            <div style="font-size: 11px; color: #A89F91;">Simulated Visa / Mastercard (4242...)</div>
          </div>
        </label>
      </div>

      <!-- Buttons -->
      <div style="padding: 12px 24px 24px; display: flex; flex-direction: column; gap: 10px;">
        <button id="sim-pay-btn" class="sim-btn-pay" style="
          width: 100%;
          padding: 14px;
          border-radius: 12px;
          border: none;
          background: linear-gradient(135deg, #C88C50, #B2763D);
          color: #140D08;
          font-weight: 700;
          font-size: 15px;
          cursor: pointer;
          transition: all 0.2s;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
        ">
          <span>Complete Demo Payment (₹${formattedAmount})</span>
        </button>

        <button id="sim-cancel-btn" style="
          width: 100%;
          padding: 10px;
          border-radius: 10px;
          border: 1px solid rgba(255,255,255,0.1);
          background: transparent;
          color: #A89F91;
          font-size: 13px;
          cursor: pointer;
        ">Cancel Transaction</button>
      </div>
    </div>
  `;

  document.body.appendChild(container);

  const cleanUp = () => {
    container.remove();
  };

  const closeBtn = container.querySelector("#sim-close-btn");
  const cancelBtn = container.querySelector("#sim-cancel-btn");
  const payBtn = container.querySelector("#sim-pay-btn") as HTMLButtonElement | null;

  closeBtn?.addEventListener("click", () => {
    cleanUp();
    if (options.onDismiss) options.onDismiss();
  });

  cancelBtn?.addEventListener("click", () => {
    cleanUp();
    if (options.onDismiss) options.onDismiss();
  });

  payBtn?.addEventListener("click", () => {
    if (payBtn) {
      payBtn.disabled = true;
      payBtn.innerHTML = `<span>Processing Approval...</span>`;
      payBtn.style.opacity = "0.7";
    }

    setTimeout(() => {
      cleanUp();
      const simulatedPaymentId = `pay_sim_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
      options.onSuccess({
        razorpay_payment_id: simulatedPaymentId,
        razorpay_order_id: options.orderId,
        razorpay_signature: "simulated_signature_approved",
      });
    }, 600);
  });
}

/**
 * Opens Razorpay Checkout modal or test gateway simulator.
 */
export async function openRazorpayCheckout(options: RazorpayCheckoutOptions): Promise<void> {
  const isRealRazorpayKey = Boolean(
    options.isLive &&
    options.keyId &&
    !options.keyId.includes("test_brew_mobile") &&
    /^rzp_(live|test)_[a-zA-Z0-9]{14,}$/.test(options.keyId)
  );

  if (isRealRazorpayKey) {
    const isLoaded = await loadRazorpayScript();

    if (isLoaded && window.Razorpay) {
      const rzp = new window.Razorpay({
        key: options.keyId,
        amount: options.amount,
        currency: options.currency || "INR",
        name: options.name || "BREW Mobile Sanctuary",
        description: options.description || "Artisanal Coffee & Bakery Order",
        image: "/assets/cup1.png",
        order_id: options.orderId.startsWith("order_test_") ? undefined : options.orderId,
        prefill: {
          name: options.customerName || "Sanctuary Guest",
          contact: options.customerPhone || "",
          email: options.customerEmail || "guest@brew.cafe",
        },
        theme: {
          color: "#DFAB6C",
          backdrop_color: "#140D08",
        },
        modal: {
          ondismiss: () => {
            if (options.onDismiss) options.onDismiss();
          },
        },
        handler: function (response: {
          razorpay_payment_id?: string;
          razorpay_order_id?: string;
          razorpay_signature?: string;
        }) {
          options.onSuccess({
            razorpay_payment_id: response.razorpay_payment_id || `pay_${Date.now()}`,
            razorpay_order_id: response.razorpay_order_id || options.orderId,
            razorpay_signature: response.razorpay_signature || "simulated_signature",
          });
        },
      });

      rzp.open();
      return;
    }
  }

  // Launch the in-app interactive test simulator modal
  openSimulationCheckoutModal(options);
}
