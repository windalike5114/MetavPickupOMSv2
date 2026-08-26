export const WAREHOUSE_ADDRESSES: Record<string, string> = {
  AKL: "123 Auckland St, Auckland, New Zealand",
  CHC: "456 Christchurch Rd, Christchurch, New Zealand",
};

export const WAREHOUSE_NAMES: Record<string, string> = {
  AKL: "Auckland",
  CHC: "Christchurch",
};

export const API_BASE_URL = "";
export const APP_VERSION = "1.2.0";
const isCnHostname =
  typeof window !== "undefined" &&
  (window.location.hostname === "cn.acapickup.com" ||
    window.location.hostname.startsWith("cn."));

export const CN_API_ONLY = import.meta.env.VITE_CN_API_ONLY === "true" || isCnHostname;
