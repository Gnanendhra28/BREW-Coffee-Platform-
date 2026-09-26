"use client";

import React, { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Shield,
  Truck,
  TrendingUp,
  Zap,
  LogOut,
  MapPin,
  ChevronLeft,
  DollarSign,
  Coffee,
  CheckCircle,
  Plus,
  Trash2,
} from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { useVan } from "@/context/VanContext";

export default function FleetAdminPage() {
  const router = useRouter();
  const { user, signOutUser } = useAuth();
  const {
    orders,
    vanLocation,
    updateVanLocation,
    futureStops,
    addFutureStop,
    deleteFutureStop,
    inventory,
    flashDeal,
    toggleFlashDeal,
    updateFlashDeal,
  } = useVan();

  const [activeTab, setActiveTab] = useState<"overview" | "fleet_stops" | "flash_deals" | "security">("overview");

  // Add stop state
  const [newDate, setNewDate] = useState("");
  const [newCity, setNewCity] = useState("Hyderabad");
  const [newState, setNewState] = useState<"Telangana" | "Andhra Pradesh">("Telangana");
  const [newSpot, setNewSpot] = useState("");
  const [newAddress, setNewAddress] = useState("");
  const [newHours, setNewHours] = useState("8:00 AM — 4:00 PM");
  const [stopSuccess, setStopSuccess] = useState("");

  // Location edit
  const [editSpot, setEditSpot] = useState(vanLocation.spotName);
  const [editStatus, setEditStatus] = useState(vanLocation.status);
  const [locSaved, setLocSaved] = useState(false);

  // Financial calculations
  const totalRevenue = orders.reduce((sum, o) => sum + (o.status !== "cancelled" ? o.totalAmount : 0), 0);
  const totalDrinks = orders.reduce(
    (sum, o) => sum + o.items.reduce((s, i) => s + i.quantity, 0),
    0
  );

  const handleAddStop = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newDate || !newSpot) return;
    addFutureStop({
      date: newDate,
      dayOfWeek: "Scheduled Tour",
      city: newCity,
      state: newState,
      spotName: newSpot,
      address: newAddress || `${newCity}, ${newState}`,
      hours: newHours,
      status: "scheduled",
      badge: "Fleet Tour",
    });
    setStopSuccess("New stop added to master tour schedule!");
    setNewDate("");
    setNewSpot("");
    setNewAddress("");
    setTimeout(() => setStopSuccess(""), 3000);
  };

  const handleSaveLocation = () => {
    updateVanLocation({
      spotName: editSpot,
      status: editStatus,
    });
    setLocSaved(true);
    setTimeout(() => setLocSaved(false), 2500);
  };

  return (
    <div className="min-h-screen bg-[#0e0d0c] text-white flex flex-col font-sans">
      {/* Top Admin Header */}
      <header className="sticky top-0 z-40 bg-[#161513]/95 backdrop-blur-md border-b border-white/10 px-4 sm:px-8 py-3.5 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link
            href="/"
            className="flex items-center gap-1.5 text-xs text-white/50 hover:text-[#c49a45] transition-colors"
          >
            <ChevronLeft className="w-4 h-4" />
            <span className="hidden sm:inline">Storefront</span>
          </Link>
          <div className="h-4 w-px bg-white/10" />
          <div className="flex items-center gap-2">
            <span className="font-serif font-black tracking-widest text-[#c49a45] text-lg">
              BREW FLEET COMMAND
            </span>
            <span className="px-2 py-0.5 rounded-full bg-[#c49a45]/20 text-[#c49a45] text-[10px] font-mono font-bold uppercase tracking-wider border border-[#c49a45]/30">
              Admin clearance
            </span>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="hidden sm:flex flex-col text-right">
            <span className="text-xs font-bold text-white flex items-center gap-1 justify-end">
              <Shield className="w-3.5 h-3.5 text-[#c49a45]" />
              <span>{user?.displayName || "Fleet Commander"}</span>
            </span>
            <span className="text-[10px] text-white/40 font-mono">
              {user?.email || "admin@brew.cafe"}
            </span>
          </div>

          <button
            onClick={async () => {
              await signOutUser();
              router.push("/login");
            }}
            className="px-3 py-1.5 rounded-xl bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/20 text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer"
          >
            <LogOut className="w-3.5 h-3.5" />
            <span>Sign Out</span>
          </button>
        </div>
      </header>

      {/* Admin Navigation Tabs */}
      <div className="bg-[#12110f] border-b border-white/5 px-4 sm:px-8 py-2 flex gap-2 overflow-x-auto text-xs font-semibold">
        <button
          onClick={() => setActiveTab("overview")}
          className={`px-4 py-2 rounded-xl transition-all ${
            activeTab === "overview"
              ? "bg-[#c49a45] text-black font-bold shadow"
              : "text-white/60 hover:text-white hover:bg-white/5"
          }`}
        >
          Operations Overview
        </button>
        <button
          onClick={() => setActiveTab("fleet_stops")}
          className={`px-4 py-2 rounded-xl transition-all ${
            activeTab === "fleet_stops"
              ? "bg-[#c49a45] text-black font-bold shadow"
              : "text-white/60 hover:text-white hover:bg-white/5"
          }`}
        >
          Tour Schedule & Stops ({futureStops.length})
        </button>
        <button
          onClick={() => setActiveTab("flash_deals")}
          className={`px-4 py-2 rounded-xl transition-all ${
            activeTab === "flash_deals"
              ? "bg-[#c49a45] text-black font-bold shadow"
              : "text-white/60 hover:text-white hover:bg-white/5"
          }`}
        >
          Flash Deal Override
        </button>
        <button
          onClick={() => setActiveTab("security")}
          className={`px-4 py-2 rounded-xl transition-all ${
            activeTab === "security"
              ? "bg-[#c49a45] text-black font-bold shadow"
              : "text-white/60 hover:text-white hover:bg-white/5"
          }`}
        >
          Staff & Shift Security
        </button>
      </div>

      {/* Main Content Area */}
      <main className="flex-1 p-4 sm:p-8 max-w-7xl w-full mx-auto space-y-8">
        {/* OVERVIEW TAB */}
        {activeTab === "overview" && (
          <div className="space-y-6">
            {/* KPI Cards */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="bg-[#181614] border border-white/10 rounded-2xl p-5 shadow-lg">
                <div className="flex items-center justify-between text-white/50 text-xs mb-2">
                  <span>Gross Revenue</span>
                  <DollarSign className="w-4 h-4 text-[#c49a45]" />
                </div>
                <div className="text-2xl font-serif font-black text-white">
                  ₹{totalRevenue.toLocaleString()}
                </div>
                <p className="text-[11px] text-emerald-400 mt-1 flex items-center gap-1">
                  <TrendingUp className="w-3 h-3" />
                  <span>Real-time cloud tally</span>
                </p>
              </div>

              <div className="bg-[#181614] border border-white/10 rounded-2xl p-5 shadow-lg">
                <div className="flex items-center justify-between text-white/50 text-xs mb-2">
                  <span>Total Drinks Brewed</span>
                  <Coffee className="w-4 h-4 text-[#c49a45]" />
                </div>
                <div className="text-2xl font-serif font-black text-white">
                  {totalDrinks} cups
                </div>
                <p className="text-[11px] text-white/50 mt-1">Across all mobile tickets</p>
              </div>

              <div className="bg-[#181614] border border-white/10 rounded-2xl p-5 shadow-lg">
                <div className="flex items-center justify-between text-white/50 text-xs mb-2">
                  <span>Coffee Beans Stock</span>
                  <Truck className="w-4 h-4 text-[#c49a45]" />
                </div>
                <div className="text-2xl font-serif font-black text-white">
                  {inventory.coffeeBeansKg.toFixed(1)} kg
                </div>
                <p className="text-[11px] text-white/50 mt-1">
                  Cups remaining: ~{Math.floor(inventory.coffeeBeansKg * 55)}
                </p>
              </div>

              <div className="bg-[#181614] border border-white/10 rounded-2xl p-5 shadow-lg">
                <div className="flex items-center justify-between text-white/50 text-xs mb-2">
                  <span>Active Van Status</span>
                  <MapPin className="w-4 h-4 text-[#c49a45]" />
                </div>
                <div className="text-lg font-bold text-white capitalize">
                  {vanLocation.status}
                </div>
                <p className="text-[11px] text-white/50 mt-1 truncate">{vanLocation.spotName}</p>
              </div>
            </div>

            {/* Live Van Location & Status Control */}
            <div className="bg-[#181614] border border-white/10 rounded-2xl p-6">
              <h3 className="text-base font-serif font-bold text-white mb-4 flex items-center gap-2">
                <Truck className="w-4 h-4 text-[#c49a45]" />
                <span>Live Van Stationing & Dispatch</span>
              </h3>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                  <label className="text-xs text-white/60 block mb-1">Assigned Spot Name</label>
                  <input
                    type="text"
                    value={editSpot}
                    onChange={(e) => setEditSpot(e.target.value)}
                    className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm text-white focus:border-[#c49a45] focus:outline-none"
                  />
                </div>

                <div>
                  <label className="text-xs text-white/60 block mb-1">Service Status</label>
                  <select
                    value={editStatus}
                    onChange={(e) =>
                      setEditStatus(e.target.value as "serving" | "moving" | "closed" | "break")
                    }
                    className="w-full bg-[#181614] border border-white/10 rounded-xl px-3 py-2 text-sm text-white focus:border-[#c49a45] focus:outline-none"
                  >
                    <option value="serving">Serving Guests (Live)</option>
                    <option value="moving">In Transit (Relocating)</option>
                    <option value="break">Crew Break</option>
                    <option value="closed">Closed for Shift</option>
                  </select>
                </div>

                <div className="flex items-end">
                  <button
                    onClick={handleSaveLocation}
                    className="w-full py-2.5 rounded-xl bg-[#c49a45] hover:bg-[#b08736] text-black font-bold text-xs transition-colors flex items-center justify-center gap-1.5 cursor-pointer"
                  >
                    <CheckCircle className="w-4 h-4" />
                    <span>{locSaved ? "Broadcasted!" : "Broadcast Van Location"}</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* FLEET STOPS TAB */}
        {activeTab === "fleet_stops" && (
          <div className="space-y-6">
            <div className="bg-[#181614] border border-white/10 rounded-2xl p-6">
              <h3 className="text-base font-serif font-bold text-white mb-4 flex items-center gap-2">
                <Plus className="w-4 h-4 text-[#c49a45]" />
                <span>Schedule New City Stop</span>
              </h3>

              <form onSubmit={handleAddStop} className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                <div>
                  <label className="text-xs text-white/60 block mb-1">Tour Date</label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. Tomorrow, Sep 28"
                    value={newDate}
                    onChange={(e) => setNewDate(e.target.value)}
                    className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm text-white focus:border-[#c49a45] focus:outline-none"
                  />
                </div>
                <div>
                  <label className="text-xs text-white/60 block mb-1">Spot Name</label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. DLF Cybercity"
                    value={newSpot}
                    onChange={(e) => setNewSpot(e.target.value)}
                    className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm text-white focus:border-[#c49a45] focus:outline-none"
                  />
                </div>
                <div>
                  <label className="text-xs text-white/60 block mb-1">City & State</label>
                  <select
                    value={newCity}
                    onChange={(e) => {
                      setNewCity(e.target.value);
                      if (e.target.value === "Visakhapatnam" || e.target.value === "Vijayawada") {
                        setNewState("Andhra Pradesh");
                      } else {
                        setNewState("Telangana");
                      }
                    }}
                    className="w-full bg-[#181614] border border-white/10 rounded-xl px-3 py-2 text-sm text-white focus:border-[#c49a45] focus:outline-none"
                  >
                    <option value="Hyderabad">Hyderabad (Telangana)</option>
                    <option value="Visakhapatnam">Visakhapatnam (Andhra Pradesh)</option>
                    <option value="Vijayawada">Vijayawada (Andhra Pradesh)</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs text-white/60 block mb-1">Operating Hours</label>
                  <input
                    type="text"
                    value={newHours}
                    onChange={(e) => setNewHours(e.target.value)}
                    className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm text-white focus:border-[#c49a45] focus:outline-none"
                  />
                </div>
                <div className="sm:col-span-2 lg:col-span-4 flex justify-between items-center mt-2">
                  {stopSuccess && <p className="text-emerald-400 text-xs font-semibold">{stopSuccess}</p>}
                  <button
                    type="submit"
                    className="ml-auto px-5 py-2.5 rounded-xl bg-[#c49a45] hover:bg-[#b08736] text-black font-bold text-xs transition-colors cursor-pointer"
                  >
                    Publish to Customer Map
                  </button>
                </div>
              </form>
            </div>

            {/* Stops list */}
            <div className="bg-[#181614] border border-white/10 rounded-2xl p-6">
              <h3 className="text-base font-serif font-bold text-white mb-4">
                Active Tour Stops ({futureStops.length})
              </h3>
              {futureStops.length === 0 ? (
                <p className="text-white/40 text-xs py-4 text-center">No scheduled stops in queue.</p>
              ) : (
                <div className="space-y-3">
                  {futureStops.map((stop) => (
                    <div
                      key={stop.id}
                      className="p-4 rounded-xl bg-white/5 border border-white/10 flex items-center justify-between gap-4"
                    >
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-white text-sm">{stop.spotName}</span>
                          <span className="px-2 py-0.5 rounded-full bg-white/10 text-[#c49a45] text-[10px] font-mono">
                            {stop.city}
                          </span>
                        </div>
                        <p className="text-xs text-white/60 mt-0.5">
                          {stop.date} • {stop.hours}
                        </p>
                      </div>
                      <button
                        onClick={() => deleteFutureStop(stop.id)}
                        className="p-2 rounded-lg bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/20 text-xs transition-colors cursor-pointer"
                        title="Delete stop"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* FLASH DEALS TAB */}
        {activeTab === "flash_deals" && (
          <div className="bg-[#181614] border border-white/10 rounded-2xl p-6 space-y-6">
            <div className="flex items-center justify-between pb-4 border-b border-white/10">
              <div>
                <h3 className="text-base font-serif font-bold text-white flex items-center gap-2">
                  <Zap className="w-4 h-4 text-[#c49a45]" />
                  <span>Flash Deal Commander</span>
                </h3>
                <p className="text-xs text-white/50 mt-1">
                  Instantly broadcast discount promotions to all customer phones
                </p>
              </div>
              <button
                onClick={() => toggleFlashDeal()}
                className={`px-4 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer ${
                  flashDeal.isActive
                    ? "bg-emerald-500 text-black shadow-lg"
                    : "bg-white/10 text-white/70 hover:bg-white/20"
                }`}
              >
                {flashDeal.isActive ? "Flash Deal ACTIVE (Broadcasting)" : "Activate Flash Deal"}
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="text-xs text-white/60 block mb-1">Deal Title</label>
                <input
                  type="text"
                  value={flashDeal.title}
                  onChange={(e) => updateFlashDeal({ title: e.target.value })}
                  className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm text-white focus:border-[#c49a45] focus:outline-none"
                />
              </div>
              <div>
                <label className="text-xs text-white/60 block mb-1">Discount Percentage (%)</label>
                <input
                  type="number"
                  value={flashDeal.discountPercent}
                  onChange={(e) => updateFlashDeal({ discountPercent: Number(e.target.value) })}
                  className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm text-white focus:border-[#c49a45] focus:outline-none"
                />
              </div>
              <div className="sm:col-span-2">
                <label className="text-xs text-white/60 block mb-1">Promo Tagline</label>
                <input
                  type="text"
                  value={flashDeal.tagline}
                  onChange={(e) => updateFlashDeal({ tagline: e.target.value })}
                  className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm text-white focus:border-[#c49a45] focus:outline-none"
                />
              </div>
            </div>
          </div>
        )}

        {/* SECURITY TAB */}
        {activeTab === "security" && (
          <div className="bg-[#181614] border border-white/10 rounded-2xl p-6 space-y-6">
            <h3 className="text-base font-serif font-bold text-white flex items-center gap-2">
              <Shield className="w-4 h-4 text-[#c49a45]" />
              <span>Staff Authentication & Shift Keys</span>
            </h3>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="p-4 rounded-xl bg-white/5 border border-white/10">
                <h4 className="font-bold text-sm text-white mb-2">Barista KDS Shift PIN</h4>
                <p className="text-xs text-white/50 mb-3">
                  Used by mobile van baristas to unlock order queues on iPad/tablet KDS.
                </p>
                <div className="p-3 bg-black/40 rounded-lg border border-white/10 font-mono text-sm text-[#c49a45] font-bold">
                  Current PIN: 2026
                </div>
              </div>

              <div className="p-4 rounded-xl bg-white/5 border border-white/10">
                <h4 className="font-bold text-sm text-white mb-2">Fleet Commander Master PIN</h4>
                <p className="text-xs text-white/50 mb-3">
                  Grants full administrative clearance across all tour schedules and deals.
                </p>
                <div className="p-3 bg-black/40 rounded-lg border border-white/10 font-mono text-sm text-[#c49a45] font-bold">
                  Current PIN: 7788
                </div>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
