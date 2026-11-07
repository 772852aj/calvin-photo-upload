import type { Metadata, Viewport } from "next";
import "./kitchen.css";

export const metadata: Metadata = {
  title: "Kitchen Inventory",
  description: "Photo-based inventory for the deep freezer, pantry and fridge.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0f3b57",
};

export default function KitchenLayout({ children }: { children: React.ReactNode }) {
  return children;
}
