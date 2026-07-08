"use client";

import React, { useEffect, useState, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "@/components/ui/accordion";
import { Card } from "@/components/ui/card";
import { supabase } from "@/utils/supabase";
import {
  ChevronDown,
  ChevronUp,
  Funnel,
  Plus,
  Trash2,
  Pencil,
  Save,
  Copy,
} from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

const escapeRegExp = (string: string) => {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
};
import { ForPoolingButton } from "@/components/for-pooling-button";
import { toast } from "sonner";
import { collection, query, where, onSnapshot, getDocs, limit, addDoc, doc, getDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import FilteringComponent from "@/components/filtering-component-v2";
import AddProductComponent from "@/components/add-product-component";
import EditProductComponent from "@/components/edit-product-component";
import CardDetails from "@/components/spf/dialog/card-details";
import SPFRequestFetchVersionHistory from "./spf-request-fetch-version-history";
import SPFTimer from "@/components/spf-timer";
import { useUser } from "@/contexts/UserContext";
import { useNotificationTriggers } from "@/hooks/use-notification-triggers";
import MultipleSpecsDetected from "@/components/multiple-specs-detected";
import { useRoleAccess } from "@/contexts/RoleAccessContext";
import { generateTDSPdf } from "@/lib/generateTDSPdf";
import { logProductEvent } from "@/lib/auditlogger";
import SPFGenerateTDSDialog from "@/components/spf-generate-tds-dialog";
import RevisionTypeSelector, { RevisionType } from "@/components/revision-type-selector";

/* ─────────────────────────────────────────────────────────────── */
/* TYPES                                                           */
/* ─────────────────────────────────────────────────────────────── */
type SPFViewProps = {
  spfNumber: string;
  processBy?: string;
  onOpen?: () => void;
  triggerDataAttr?: string;
  triggerMode?: "view" | "edit";
  showPoolingButton?: boolean;
  onRefresh?: () => void | Promise<void>;
};

type SPFData = {
  spf_number: string;
  status?: string;
  item_code?: string;
  supplier_brand: string;
  supplier_branch?: string;
  product_offer_image: string;
  product_offer_qty: string;
  product_offer_technical_specification: string;
  original_technical_specification?: string;
  product_reference_id?: string;
  product_offer_unit_cost: string;
  product_offer_pcs_per_carton?: string;
  product_offer_packaging_details: string;
  warranty?: string;
  product_offer_factory_address: string;
  product_offer_port_of_discharge: string;
  product_offer_subtotal: string;
  company_name?: string;
  contact_name?: string;
  contact_number?: string;
  proj_lead_time?: string;
  final_selling_cost?: string;
  final_unit_cost?: string;
  final_subtotal?: string;
  referenceid?: string;
  tsm?: string;
  manager?: string;
  item_added_author?: string;
  price_validity?: string;
  tds?: string;
  dimensional_drawing?: string;
  illuminance_drawing?: string;
  revision_type?: string;
  revision_remarks?: string;
  spf_remarks_pd?: string;
  spf_remarks_procurement?: string;
  commercial_type?: string;
};

type SPFRequestData = {
  item_description: string;
  item_photo: string;
  item_code?: string;
  item_qty?: string;
};

const ROW_SEP = "|ROW|";
const ROW_BOUNDARY = "|ROW|";

type SpecGroup = { title: string; specs: string[] };

/* ─────────────────────────────────────────────────────────────── */
/* PIPE DETECTION HELPER                                           */
/* ─────────────────────────────────────────────────────────────── */
function hasMultipleSpecValues(product: any): boolean {
  if (!product?.technicalSpecifications) return false;
  return product.technicalSpecifications.some((group: any) =>
    group.specs?.some((spec: any) => {
      const values = (spec.value || "")
        .split("|")
        .map((v: string) => v.trim())
        .filter(Boolean);
      return values.length > 1;
    }),
  );
}

/* ─────────────────────────────────────────────────────────────── */
/* NAME CACHE FOR AUDIT TRAIL RESOLUTION                           */
/* ─────────────────────────────────────────────────────────────── */
const nameCache = new Map<string, string>();

async function resolveNames(referenceIDs: string[]): Promise<void> {
  const unresolved = referenceIDs.filter((id) => id && !nameCache.has(id));
  if (!unresolved.length) return;
  await Promise.allSettled(
    unresolved.map(async (refId) => {
      try {
        const response = await fetch(
          `/api/users?referenceID=${encodeURIComponent(refId)}`,
        );
        if (response.ok) {
          const user = await response.json();
          nameCache.set(
            refId,
            user?.Firstname
              ? `${user.Firstname} ${user.Lastname ?? ""}`.trim()
              : refId,
          );
        } else {
          nameCache.set(refId, refId);
        }
      } catch {
        nameCache.set(refId, refId);
      }
    }),
  );
}

function getResolvedName(referenceID: string | undefined): string {
  if (!referenceID) return "";
  return nameCache.get(referenceID) ?? referenceID;
}

/* ─────────────────────────────────────────────────────────────── */
/* STATUS LABEL MAPPING                                            */
/* ─────────────────────────────────────────────────────────────── */
function getStatusLabel(status: string | undefined): string {
  if (status === "Pending For Procurement") return "For Procurement Costing";
  if (status === "Approved By Procurement") return "Ready For Quotation";
  if (status === "For Revision") return "FOR REVISION";
  return status ?? "";
}

/* ─────────────────────────────────────────────────────────────── */
/* SPEC PARSERS (view mode)                                        */
/* ─────────────────────────────────────────────────────────────── */
function parseTechSpec(raw: string): SpecGroup[] {
  if (!raw || raw === "-") return [];
  if (raw.includes("~~")) {
    return raw.split("@@").map((chunk) => {
      const [titlePart, rest = ""] = chunk.split("~~");
      const specs = rest
        .split(";;")
        .map((s) => s.trim())
        .filter(Boolean);
      return { title: titlePart.trim(), specs };
    });
  }
  const specs = raw
    .split(" | ")
    .map((s) => s.trim())
    .filter(Boolean);
  return specs.length ? [{ title: "", specs }] : [];
}

function splitByRow(value: string | undefined, rowStructure?: number[]): string[][] {
  if (!value) return [];
  const items = value.split(ROW_SEP).map((v) => v.trim());
  
  // If we have row structure (item counts per row), use it to distribute items
  if (rowStructure && rowStructure.length > 0) {
    const rows: string[][] = [];
    let itemIndex = 0;
    
    for (const itemCount of rowStructure) {
      const rowItems = items.slice(itemIndex, itemIndex + itemCount);
      rows.push(rowItems);
      itemIndex += itemCount;
    }
    
    return rows;
  }
  
  // Default: return as single row
  return [items];
}

function splitSpecsByRow(value: string | undefined, rowStructure?: number[]): SpecGroup[][][] {
  if (!value) return [];
  const items = value.split(ROW_SEP).map((v) => v.trim());
  
  // If we have row structure (item counts per row), use it to distribute items
  if (rowStructure && rowStructure.length > 0) {
    const rows: SpecGroup[][][] = [];
    let itemIndex = 0;
    
    for (const itemCount of rowStructure) {
      const rowItems = items.slice(itemIndex, itemIndex + itemCount);
      rows.push(rowItems.map(parseTechSpec));
      itemIndex += itemCount;
    }
    
    return rows;
  }
  
  // Default: return as single row
  return [items.map(parseTechSpec)];
}

// Derive row structure from item_code (which has row prefixes like SPF-XXX-001, SPF-XXX-002, etc.)
const deriveRowStructure = (itemCode: string | undefined): number[] => {
  if (!itemCode || itemCode === "-") return [];
  const items = itemCode.split(ROW_SEP).map((v) => v.trim());
  const structure: number[] = [];
  let currentRowPrefix = "";
  let currentCount = 0;
  
  for (const item of items) {
    // Match the full SPF number with row index (e.g., SPF-DSI-26-TEST-002)
    // This is the base before any option suffixes like -A, -B, -OPT-2123
    const rowMatch = item.match(/^([A-Z0-9-]+-\d{3})/);
    if (rowMatch) {
      const rowPrefix = rowMatch[1];
      if (rowPrefix !== currentRowPrefix) {
        if (currentCount > 0) {
          structure.push(currentCount);
        }
        currentRowPrefix = rowPrefix;
        currentCount = 1;
      } else {
        currentCount++;
      }
    } else {
      currentCount++;
    }
  }
  
  if (currentCount > 0) {
    structure.push(currentCount);
  }
  
  return structure.length > 0 ? structure : [items.length];
};

type LightMultipleRow = {
  itemName?: string;
  unitCost?: number;
  length?: number | string;
  width?: number | string;
  height?: number | string;
  qtyPerCarton?: number;
};

type MultiPackagingPayloadV1 = {
  v: 1;
  type: "LIGHT_MULTIPLE";
  rows: LightMultipleRow[];
};

function decodeBase64ToString(base64: string): string | null {
  try {
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8").decode(bytes);
  } catch {
    return null;
  }
}

function decodeMultiPackaging(packagingStr: string | undefined): MultiPackagingPayloadV1 | null {
  const raw = (packagingStr ?? "").trim();
  if (!raw.startsWith("MULTI:")) return null;
  const b64 = raw.slice("MULTI:".length);
  const decoded = decodeBase64ToString(b64);
  if (!decoded) return null;
  try {
    const parsed = JSON.parse(decoded);
    if (parsed?.v !== 1 || parsed?.type !== "LIGHT_MULTIPLE" || !Array.isArray(parsed?.rows)) {
      return null;
    }
    return parsed as MultiPackagingPayloadV1;
  } catch {
    return null;
  }
}

function parseHumanReadableMultiPackaging(packagingStr: string | undefined): MultiPackagingPayloadV1 | null {
  const raw = (packagingStr ?? "").trim();
  if (!raw || raw === "-") return null;
  
  // Check if it's the old base64 format
  if (raw.startsWith("MULTI:")) {
    return decodeMultiPackaging(raw);
  }
  
  // Parse new human-readable format (4 lines per item: name, qty, dimensions, unitCost)
  const lines = raw.split("\n").map(l => l.trim()).filter(l => l);
  if (lines.length === 0) return null;
  
  // Check if it's the old 3-line format (name, dimensions, unitCost) or new 4-line format
  const isOldFormat = lines.length % 3 === 0;
  const isNewFormat = lines.length % 4 === 0;
  
  if (!isOldFormat && !isNewFormat) return null;
  
  const rows: LightMultipleRow[] = [];
  const linesPerItem = isNewFormat ? 4 : 3;
  
  for (let i = 0; i < lines.length; i += linesPerItem) {
    const itemName = lines[i] || "";
    
    let qtyPerCarton = 0;
    let dimensions = "";
    let unitCostStr = "";
    
    if (isNewFormat) {
      // New format: name, qty, dimensions, unitCost
      const qtyLine = lines[i + 1] || "";
      dimensions = lines[i + 2] || "";
      unitCostStr = lines[i + 3] || "";
      
      // Parse qty (e.g., "Qty: 552")
      const qtyMatch = qtyLine.match(/^Qty:\s*(\d+)/);
      qtyPerCarton = qtyMatch ? parseInt(qtyMatch[1], 10) : 0;
    } else {
      // Old format: name, dimensions, unitCost (qty not stored)
      dimensions = lines[i + 1] || "";
      unitCostStr = lines[i + 2] || "";
      qtyPerCarton = 0;
    }
    
    // Parse dimensions (e.g., "2222333 × 33 × 44334")
    const dimParts = dimensions.split("×").map(p => p.trim());
    const length = dimParts[0] || "-";
    const width = dimParts[1] || "-";
    const height = dimParts[2] || "-";
    
    // Parse unit cost (e.g., "230.67 USD")
    const costMatch = unitCostStr.match(/^([\d.]+)/);
    const unitCost = costMatch ? parseFloat(costMatch[1]) : 0;
    
    rows.push({
      itemName,
      length,
      width,
      height,
      unitCost,
      qtyPerCarton,
    });
  }
  
  if (rows.length === 0) return null;
  
  return {
    v: 1,
    type: "LIGHT_MULTIPLE",
    rows,
  };
}

function formatCommercialDetailsForView(
  commercialTypeRaw: string | undefined,
  packagingStr: string | undefined,
  pcsPerCartonStr: string | undefined,
  productName?: string,
): { qtyCtn: React.ReactNode; commercialType: React.ReactNode; packaging: React.ReactNode } {
  let ct = (commercialTypeRaw || "BASIC").toUpperCase();

  // Derive commercial type from product name if it contains "Lights (multiple)" or "Lights (single)"
  if (productName) {
    const productNameLower = productName.toLowerCase();
    if (productNameLower.includes("lights (multiple)") || productNameLower.includes("light (multiple)")) {
      ct = "LIGHT";
    } else if (productNameLower.includes("lights (single)") || productNameLower.includes("light (single)")) {
      ct = "LIGHT";
    }
  }

  const pack = packagingStr && packagingStr !== "" ? packagingStr : "-";
  const pcs = pcsPerCartonStr && pcsPerCartonStr !== "" ? pcsPerCartonStr : "-";

  if (ct === "POLE") {
    return { qtyCtn: "-", commercialType: "Pole", packaging: "-" };
  }

  if (ct === "LIGHT") {
    const multi = parseHumanReadableMultiPackaging(pack);

    // Check product name to determine if it should be Multiple or Single
    let isMultiple = multi?.rows ? multi.rows.length > 0 : false;
    if (productName) {
      const productNameLower = productName.toLowerCase();
      if (productNameLower.includes("lights (multiple)") || productNameLower.includes("light (multiple)")) {
        isMultiple = true;
      } else if (productNameLower.includes("lights (single)") || productNameLower.includes("light (single)")) {
        isMultiple = false;
      }
    }

    if (isMultiple && multi?.rows && multi.rows.length > 0) {
      const rows = multi.rows;
      return {
        qtyCtn: (
          <div className="space-y-1">
            {rows.map((row, idx) => (
              <div key={idx} className="text-[11px] leading-tight">
                <div className="font-medium">{row.itemName || `Item ${idx + 1}`}</div>
                <div>Qty: {row.qtyPerCarton ?? "-"}</div>
              </div>
            ))}
          </div>
        ),
        commercialType: "Light (Multiple)",
        packaging: (
          <div className="space-y-1">
            {rows.map((row, idx) => (
              <div key={idx} className="text-[11px] leading-tight">
                <div className="font-medium">{row.itemName || `Item ${idx + 1}`}</div>
                <div>
                  {(row.length ?? "-").toString()} × {(row.width ?? "-").toString()} × {(row.height ?? "-").toString()}
                </div>
                <div className="text-gray-500">
                  {(Number(row.unitCost ?? 0) || 0).toFixed(2)} USD
                </div>
              </div>
            ))}
          </div>
        ),
      };
    }

    return { qtyCtn: pcs, commercialType: "Light (Single)", packaging: pack };
  }

  return { qtyCtn: pcs, commercialType: "Basic", packaging: pack };
}

/* ─────────────────────────────────────────────────────────────── */
/* MOBILE HELPERS (edit mode)                                      */
/* ─────────────────────────────────────────────────────────────── */
function InlineSpecs({ specs }: { specs: any[] }) {
  const [open, setOpen] = useState(false);
  const filtered =
    specs?.filter((g: any) => g.specs?.some((s: any) => s.value?.trim())) ?? [];
  if (!filtered.length) return null;
  return (
    <div className="mt-1">
      <div
        role="button"
        tabIndex={0}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((p) => !p);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.stopPropagation();
            setOpen((p) => !p);
          }
        }}
        className="flex items-center gap-1 text-[10px] text-muted-foreground cursor-pointer select-none"
      >
        {open ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
        View specs
      </div>
      {open && (
        <div className="text-[10px] space-y-1 mt-1 pb-1">
          {filtered.map((g: any, gi: number) => (
            <div key={gi}>
              <p className="font-semibold">{g.title}</p>
              {g.specs
                ?.filter((s: any) => s.value?.trim())
                .map((s: any, si: number) => (
                  <p key={si} className="text-muted-foreground">
                    {s.specId}: {s.value}
                  </p>
                ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function InlineProductSpecs({ specs }: { specs: any[] }) {
  const [open, setOpen] = useState(false);
  const filtered =
    specs?.filter((g: any) => g.title !== "COMMERCIAL DETAILS") ?? [];
  if (!filtered.length) return null;
  return (
    <div className="mt-1" onClick={(e) => e.stopPropagation()}>
      <div
        role="button"
        tabIndex={0}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((p) => !p);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.stopPropagation();
            setOpen((p) => !p);
          }
        }}
        className="flex items-center gap-1 text-[10px] text-muted-foreground cursor-pointer select-none"
      >
        {open ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
        Specs
      </div>
      {open && (
        <div className="text-[10px] space-y-1 mt-1 pb-1">
          {filtered.map((group: any, i: number) => (
            <div key={i}>
              <p className="font-semibold">{group.title}</p>
              {group.specs?.map((spec: any, s: number) => (
                <p key={s} className="text-muted-foreground">
                  {spec.specId}: {spec.value || "-"}
                </p>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Collapsible spec block for view mode mobile ── */
function MobileSpecsBlock({ groups }: { groups: SpecGroup[] }) {
  const [open, setOpen] = useState(false);
  if (!groups.length)
    return <span className="text-xs text-muted-foreground">-</span>;
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((p) => !p)}
        className="flex items-center gap-1 text-xs text-blue-600 font-medium"
      >
        {open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        {open ? "Hide specs" : "View specs"}
      </button>
      {open && (
        <div className="mt-1 space-y-1.5">
          {groups.map((group, gi) => (
            <div key={gi}>
              {group.title && (
                <p className="text-[10px] font-bold uppercase tracking-wide text-gray-700">
                  {group.title}
                </p>
              )}
              {group.specs.map((spec, si) => (
                <p key={si} className="text-[10px] text-gray-500 leading-snug">
                  {spec}
                </p>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────── */
/* MAIN COMPONENT                                                  */
/* ─────────────────────────────────────────────────────────────── */
export default function SPFRequestFetch({
  spfNumber,
  processBy,
  onOpen,
  triggerDataAttr,
  triggerMode = "view",
  showPoolingButton,
  onRefresh,
}: SPFViewProps) {
  const { userId } = useUser();
  const { onSPFUpdated } = useNotificationTriggers();

// ── ACCESS CONTROL ──
const { hasAccess, subscribeToUserAccess } = useRoleAccess();
const [canAddProduct, setCanAddProduct] = useState<boolean>(true);
const [canEditProduct, setCanEditProduct] = useState<boolean>(true);

// Initial check
useEffect(() => {
  hasAccess("page:add-product").then(setCanAddProduct);
  hasAccess("page:edit-product").then(setCanEditProduct);
}, [hasAccess]);

// Real-time subscription — re-check whenever access changes
useEffect(() => {
  if (!userId) return;
  const unsub = subscribeToUserAccess(userId, () => {
    hasAccess("page:add-product").then(setCanAddProduct);
    hasAccess("page:edit-product").then(setCanEditProduct);
  });
  return () => unsub();
}, [userId, subscribeToUserAccess, hasAccess]);

  /* ── Dialog / data state ── */
  const [open, setOpen] = useState(false);
  const [autoEditFired, setAutoEditFired] = useState(false);
  const [reviseFromSpecial, setReviseFromSpecial] = useState(false);
  const [data, setData] = useState<SPFData | null>(null);
  const [latestVersionLabel, setLatestVersionLabel] = useState<string | null>(
    null,
  );
  const [spfCreationStartTime, setSpfCreationStartTime] = useState<
    string | null
  >(null);
  const [spfCreationEndTime, setSpfCreationEndTime] = useState<string | null>(
    null,
  );
  const [timerActive, setTimerActive] = useState(false);
  const [requestData, setRequestData] = useState<SPFRequestData | null>(null);
  const [loading, setLoading] = useState(false);
  const [isMobile, setIsMobile] = useState(false);

  /* ── Edit mode state ── */
  const [editMode, setEditMode] = useState(false);
  const [revisionType, setRevisionType] = useState<RevisionType | null>(null);
  const [showRevisionSelector, setShowRevisionSelector] = useState(false);
  const [viewMode, setViewMode] = useState(false);
  const [productOffers, setProductOffers] = useState<Record<number, any[]>>({});
  const [originalQuantities, setOriginalQuantities] = useState<Record<string, number>>({});
  const [originalUnitCosts, setOriginalUnitCosts] = useState<Record<string, number>>({});
  const [deletedOffers, setDeletedOffers] = useState<any[]>([]);
  const [products, setProducts] = useState<any[]>([]);
  const [filteredProducts, setFilteredProducts] = useState<any[]>([]);
  const [loadingProducts, setLoadingProducts] = useState(false);
  const [productSearch, setProductSearch] = useState("");

  /* ── Pagination state ── */
  const [productPage, setProductPage] = useState(1);
  const PRODUCTS_PER_PAGE = 20;

  /* ── Edit UI state ── */
  const [openAddProduct, setOpenAddProduct] = useState(false);
  const [openEditProduct, setOpenEditProduct] = useState(false);
  const [selectedProduct, setSelectedProduct] = useState<any | null>(null);
  const [openFilter, setOpenFilter] = useState(false);
  const [draggedProduct, setDraggedProduct] = useState<any | null>(null);
  const [showTrash, setShowTrash] = useState(false);
  const [activeTab, setActiveTab] = useState<"details" | "items" | "products">(
    "items",
  );
  const [activeRowIndex, setActiveRowIndex] = useState<number | null>(null);
  const [pickerStep, setPickerStep] = useState<"list" | "confirm">("list");
  const [pendingProduct, setPendingProduct] = useState<any | null>(null);
  

  /* ── MultipleSpecsDetected modal ── */
  const [showPipeModal, setShowPipeModal] = useState(false);
  const [pendingPipeProduct, setPendingPipeProduct] = useState<any | null>(
    null,
  );
  const [pendingPipeRowIndex, setPendingPipeRowIndex] = useState<number | null>(
    null,
  );

  /* ── Row Selection modal ── */
  const [showRowSelectModal, setShowRowSelectModal] = useState(false);
  const [pendingRowSelectProduct, setPendingRowSelectProduct] = useState<any | null>(null);

/* ── Duplicate state ── */
  const [duplicateTarget, setDuplicateTarget] = useState<{ id: string; name: string } | null>(null);
  const [duplicating, setDuplicating] = useState(false);

  /* ── Submit loading state ── */
  const [isSubmitting, setIsSubmitting] = useState(false);

  /* ── Draft state ── */
  const [hasDraft, setHasDraft] = useState(false);
  const [isSavingDraft, setIsSavingDraft] = useState(false);
  const [isLoadingDraft, setIsLoadingDraft] = useState(false);
  const [draftAutoLoaded, setDraftAutoLoaded] = useState(false);
  const draftInUseRef = useRef(false);

  /* ── TDS Dialog state ── */
  const [tdsDialogOpen, setTdsDialogOpen] = useState(false);
  const [selectedProductForTDS, setSelectedProductForTDS] = useState<any | null>(null);
  const [selectedRowIndexForTDS, setSelectedRowIndexForTDS] = useState<number | null>(null);
  const [selectedOptionIndexForTDS, setSelectedOptionIndexForTDS] = useState<number | null>(null);

  /* ── Image Preview modal ── */
  const [imagePreviewOpen, setImagePreviewOpen] = useState(false);
  const [previewImageUrl, setPreviewImageUrl] = useState<string | null>(null);

  /* ── Expanded product cards state ── */
  const [expandedProductCards, setExpandedProductCards] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!open) return;
    const start = new Date().toISOString();
    setSpfCreationStartTime(start);
    setSpfCreationEndTime(null);
    setTimerActive(true);
    setDraftAutoLoaded(false);
    draftInUseRef.current = false;
  }, [open]);

  /* ── Check for existing draft and restore timer ── */
  useEffect(() => {
    if (!open || !spfNumber) return;

    const checkDraft = async () => {
      try {
        const res = await fetch(`/api/request/spf-request-get-draft-api?spf_number=${spfNumber}`);
        const data = await res.json();

        if (data?.success && data?.hasDraft) {
          setHasDraft(true);
          // Restore the saved timer start time from draft - timer continues running
          if (data.draft?.spf_creation_start_time) {
            setSpfCreationStartTime(data.draft.spf_creation_start_time);
            setTimerActive(true);
          }
        } else {
          setHasDraft(false);
        }
      } catch (err) {
        console.error("Error checking draft:", err);
      }
    };

    checkDraft();
  }, [open, spfNumber]);

  useEffect(() => {
    if (!open || !spfNumber) return;
    if (!editMode) return;
    if (!hasDraft) return;
    if (draftAutoLoaded) return;

    setDraftAutoLoaded(true);
    handleLoadDraft();
  }, [open, spfNumber, editMode, hasDraft, draftAutoLoaded]);

  useEffect(() => {
    if (!editMode && draftAutoLoaded) {
      setDraftAutoLoaded(false);
    }
  }, [editMode, draftAutoLoaded]);

  /* ── Responsive ── */
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  /* ── Product search filter ── */
  useEffect(() => {
    if (!productSearch) {
      setFilteredProducts(products);
      return;
    }
    const term = productSearch.toLowerCase();
    setFilteredProducts(
      products.filter(
        (p: any) =>
          (p.productName?.toLowerCase() || "").includes(term) ||
          (p.supplier?.supplierBrand?.toLowerCase() || "").includes(term) ||
          (p.supplier?.company?.toLowerCase() || "").includes(term) ||
          JSON.stringify(p.commercialDetails || "")
            .toLowerCase()
            .includes(term),
      ),
    );
  }, [productSearch, products]);

  /* ── Reset pagination when filters change ── */
  useEffect(() => {
    setProductPage(1);
  }, [filteredProducts, productSearch]);

  /* ── Fetch products (for edit mode) ── */
  const fetchProducts = useCallback(() => {
    setLoadingProducts(true);
    const q = query(collection(db, "products"), where("isActive", "==", true));
    const unsubscribe = onSnapshot(q, (snap) => {
      const list = snap.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .sort(
          (a: any, b: any) =>
            (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0),
        );
      setProducts(list);
      setFilteredProducts(list);
      setLoadingProducts(false);
    });
    return unsubscribe;
  }, []);

  /* ── Main data fetch ── */
  const fetchSPF = async () => {
    const { data: versionData } = await supabase
      .from("spf_creation_history")
      .select("version_label, version_number")
      .eq("spf_number", spfNumber)
      .order("version_number", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (versionData) {
      setLatestVersionLabel(
        versionData.version_label ||
          `${spfNumber}_v${versionData.version_number}`,
      );
    }

    try {
      setLoading(true);
      const { data: creation, error } = await supabase
        .from("spf_creation")
        .select("*")
        .eq("spf_number", spfNumber)
        .maybeSingle();

      if (error) {
        console.error(error);
        return;
      }
      setData(creation);

      if (creation?.item_added_author) {
        await resolveNames([creation.item_added_author]);
      }

      const { data: request } = await supabase
        .from("spf_request")
        .select("item_description,item_photo,item_code")
        .eq("spf_number", spfNumber)
        .maybeSingle();

      setRequestData(request);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) fetchSPF();
  }, [open]);

  /* ── Status poll ── */
  useEffect(() => {
    const fetchStatus = async () => {
      const { data: d } = await supabase
        .from("spf_creation")
        .select("status")
        .eq("spf_number", spfNumber)
        .maybeSingle();
      if (d) setData((prev: any) => ({ ...prev, status: d.status }));
    };
    fetchStatus();
  }, [spfNumber]);

  useEffect(() => {
    if (!open) {
      if (autoEditFired) setAutoEditFired(false);
      setReviseFromSpecial(false);
      return;
    }
    if (triggerMode !== "edit") return;
    if (autoEditFired) return;
    if (editMode) return;
    if (!data) return;

    const allowEdit =
      data?.status === "For Revision" ||
      data?.status === "Pending For Procurement" ||
      data?.status === "Approved By Procurement";
    if (!allowEdit) return;

    const existingRevisionType = data?.revision_type;
    if (existingRevisionType) {
      const typeMap: Record<string, RevisionType> = {
        "Price Update": "price",
        "Change Item Specs & Qty": "specs",
        "Both": "both",
      };
      const mappedType = typeMap[existingRevisionType];
      if (mappedType) {
        setAutoEditFired(true);
        setRevisionType(mappedType);
        setOpen(false);
        setTimeout(() => {
          enterEditMode(mappedType);
          setEditMode(true);
          setOpen(true);
        }, 50);
        return;
      }
    }

    if (reviseFromSpecial) {
      setAutoEditFired(true);
      setShowRevisionSelector(true);
      // Close main dialog when showing revision selector to prevent two dialogs
      setOpen(false);
    }
  }, [open, triggerMode, autoEditFired, editMode, data, reviseFromSpecial]);

  /* ── Handle revision type selection ── */
  const handleRevisionTypeSelect = (type: RevisionType) => {
    setRevisionType(type);
    setShowRevisionSelector(false);
    setOpen(false);
    setTimeout(() => {
      enterEditMode(type);
      setEditMode(true);
      setOpen(true);
    }, 50);
  };

  /* ── Enter edit mode ── */
  const enterEditMode = (type: RevisionType) => {
    if (!data || !requestData) return;

    const rowStructure = deriveRowStructure(data.item_code);
    
    const rowImages = splitByRow(data.product_offer_image, rowStructure);
    const rowQtys = splitByRow(data.product_offer_qty, rowStructure);
    const rowUnitCosts = splitByRow(data.product_offer_unit_cost, rowStructure);
    const rowPcsPerCartons = splitByRow(data.product_offer_pcs_per_carton, rowStructure);
    const rowPackaging = splitByRow(data.product_offer_packaging_details, rowStructure);
    const rowWarranties = splitByRow(data.warranty, rowStructure);
    const rowFactories = splitByRow(data.product_offer_factory_address, rowStructure);
    const rowPorts = splitByRow(data.product_offer_port_of_discharge, rowStructure);
    const rowSubtotals = splitByRow(data.product_offer_subtotal, rowStructure);
    const rowBrands = splitByRow(data.supplier_brand, rowStructure);
    const rowSellingCosts = splitByRow(data.final_selling_cost, rowStructure);
    const rowLeadTimes = splitByRow(data.proj_lead_time, rowStructure);
    const rowItemCodes = splitByRow(data.item_code, rowStructure);
    const rowPriceValidities = splitByRow(data.price_validity, rowStructure);
    const rowTdsBrands = splitByRow(data.tds, rowStructure);
    const rowTdsUrls = splitByRow(data.tds, rowStructure);
    const rowDimensionalDrawings = splitByRow(data.dimensional_drawing, rowStructure);
    const rowIlluminanceDrawings = splitByRow(data.illuminance_drawing, rowStructure);
    const rowProductNames = splitByRow((data as any).product_name, rowStructure);
    const rowSpfRemarksPD = splitByRow(data.spf_remarks_pd, rowStructure);
    const rowSpfRemarksProcurement = splitByRow(data.spf_remarks_procurement, rowStructure);
    const rowBranches = splitByRow(data.supplier_branch, rowStructure);
    const rowCommercialTypes = splitByRow(data.commercial_type, rowStructure);
    const rowSpecs = splitSpecsByRow(data.product_offer_technical_specification, rowStructure);
    const rowOriginalSpecs = splitSpecsByRow(data.original_technical_specification, rowStructure);
    const rowProductRefIDs = splitByRow(data.product_reference_id, rowStructure);

    const descs = (requestData.item_description || "")
      .split(",")
      .map((s) => s.trim());

    const initialOffers: Record<number, any[]> = {};
    const origQtys: Record<string, number> = {};

    descs.forEach((_, rowIndex) => {
      const imgs = rowImages[rowIndex] ?? [];
      const qtys = rowQtys[rowIndex] ?? [];
      const costs = rowUnitCosts[rowIndex] ?? [];
      const pcsPerCartons = rowPcsPerCartons[rowIndex] ?? [];
      const packs = rowPackaging[rowIndex] ?? [];
      const warranties = rowWarranties[rowIndex] ?? [];
      const facts = rowFactories[rowIndex] ?? [];
      const ports = rowPorts[rowIndex] ?? [];
      const brands = rowBrands[rowIndex] ?? [];
      const selling = rowSellingCosts[rowIndex] ?? [];
      const leads = rowLeadTimes[rowIndex] ?? [];
      const codes = rowItemCodes[rowIndex] ?? [];
      const branches = rowBranches[rowIndex] ?? [];
      const spfRemarksPD = rowSpfRemarksPD[rowIndex] ?? [];
      const commercialTypes = rowCommercialTypes[rowIndex] ?? [];

      const hasData = imgs.length > 0 && !(imgs.length === 1 && imgs[0] === "");
      if (!hasData) {
        initialOffers[rowIndex] = [];
        return;
      }

      initialOffers[rowIndex] = imgs.map((img: string, i: number) => {
        const commercialTypeRaw = (commercialTypes[i] || "BASIC").toUpperCase();
        const rawPackaging = packs[i] || "-";
        const rawPcsPerCarton = pcsPerCartons[i] || "-";

        // Normalize DB labels ("Light (Multiple)", "Basic", "Pole") to internal enum
        const isLightType = commercialTypeRaw === "LIGHT" || commercialTypeRaw.startsWith("LIGHT (");
        const isPoleType = commercialTypeRaw === "POLE";
        const isLightMultiple = commercialTypeRaw === "LIGHT (MULTIPLE)";

        let packagingData = { length: "-", width: "-", height: "-" };
        let useArrayInput = false;
        let multiRows: any[] = [];
        let totalUnitCost: number | undefined;

        if (isLightType) {
          const decodedMulti = parseHumanReadableMultiPackaging(rawPackaging);
          if (decodedMulti?.rows?.length && (isLightMultiple || decodedMulti.rows.length > 0)) {
            useArrayInput = isLightMultiple;
            if (isLightMultiple) {
              multiRows = decodedMulti.rows.map((r) => ({
                itemName: r.itemName ?? "",
                unitCost: Number(r.unitCost ?? 0) || 0,
                length: Number(r.length ?? 0) || (r.length ?? "-"),
                width: Number(r.width ?? 0) || (r.width ?? "-"),
                height: Number(r.height ?? 0) || (r.height ?? "-"),
                qtyPerCarton: Number(r.qtyPerCarton ?? 0) || 0,
              }));
              totalUnitCost = multiRows.reduce(
                (sum: number, r: any) => sum + (Number(r.unitCost) || 0),
                0,
              );
            } else {
              // Light (Single) — parse as dimensions
              const [length, width, height] = (rawPackaging || "- x - x -")
                .split(/\s*[x×]\s*/i)
                .map((v) => v.trim());
              packagingData = { length: length || "-", width: width || "-", height: height || "-" };
            }
          } else {
            const [length, width, height] = (rawPackaging || "- x - x -")
              .split(/\s*[x×]\s*/i)
              .map((v) => v.trim());
            packagingData = { length: length || "-", width: width || "-", height: height || "-" };
          }
        } else {
          // BASIC or POLE — parse packaging dimensions if present
          if (rawPackaging && rawPackaging !== "-") {
            const [length, width, height] = rawPackaging
              .split(/\s*[x×]\s*/i)
              .map((v) => v.trim());
            packagingData = { length: length || "-", width: width || "-", height: height || "-" };
          }
        }

        const originalQty = Number(qtys[i] || 1);
        // Store original quantity with key format "rowIndex_optionIndex"
        origQtys[`${rowIndex}_${i}`] = originalQty;
        return {
          __isExisting: true,
          __sellingCost: selling[i] ?? "-",
          __leadTime: leads[i] ?? "-",
          mainImage: { url: img !== "-" ? img : "" },
          productName: codes[i] ?? `Option ${i + 1}`,
          supplier: {
            supplierBrand: brands[i] !== "-" ? brands[i] : "",
            supplierBrandName: brands[i] !== "-" ? brands[i] : "",
            supplierBranch: branches[i] !== "-" ? branches[i] : "",
          },
          commercialDetails: {
            unitCost: costs[i] || "0",
            pcsPerCarton: rawPcsPerCarton,
            factoryAddress: facts[i] || "-",
            portOfDischarge: ports[i] || "-",
            packaging: packagingData,
            warranty: warranties[i] || "-",
            // Normalize stored label back to internal enum for UI display logic
            commercialType: isLightType ? "LIGHT" : isPoleType ? "POLE" : "BASIC",
            useArrayInput,
            multiRows,
            ...(typeof totalUnitCost === "number" ? { totalUnitCost } : {}),
          },
          technicalSpecifications: (rowSpecs[rowIndex]?.[i] ?? []).map(
            (group) => ({
              title: group.title,
              specs: group.specs.map((spec: string) => {
                const colonIdx = spec.indexOf(":");
                if (colonIdx === -1) return { specId: spec, value: "" };
                return {
                  specId: spec.slice(0, colonIdx).trim(),
                  value: spec.slice(colonIdx + 1).trim(),
                };
              }),
            }),
          ),
          // Store original specs from Supabase for editing multiple specs later
          // Merge ALL versions' specs with | so hasMultipleSpecValues can detect multiple versions
          __originalTechnicalSpecifications: (() => {
            const allVersions = rowOriginalSpecs[rowIndex] ?? [];
            if (allVersions.length === 0) return [];
            if (allVersions.length === 1) {
              // Single version - just parse normally
              return (allVersions[0] ?? []).map((group) => ({
                title: group.title,
                specs: group.specs.map((spec) => {
                  const colonIdx = spec.indexOf(":");
                  if (colonIdx === -1) return { specId: spec, value: "" };
                  return {
                    specId: spec.slice(0, colonIdx).trim(),
                    value: spec.slice(colonIdx + 1).trim(),
                  };
                }),
              }));
            }
            // Multiple versions - merge all version values with |
            const mergedGroups = new Map<string, Map<string, string[]>>();
            allVersions.forEach((version) => {
              version.forEach((group) => {
                if (!mergedGroups.has(group.title)) {
                  mergedGroups.set(group.title, new Map());
                }
                const specMap = mergedGroups.get(group.title)!;
                group.specs.forEach((spec) => {
                  const colonIdx = spec.indexOf(":");
                  if (colonIdx === -1) return;
                  const specId = spec.slice(0, colonIdx).trim();
                  const value = spec.slice(colonIdx + 1).trim();
                  if (!specMap.has(specId)) {
                    specMap.set(specId, []);
                  }
                  specMap.get(specId)!.push(value);
                });
              });
            });
            return Array.from(mergedGroups.entries()).map(([title, specMap]) => ({
              title,
              specs: Array.from(specMap.entries()).map(([specId, values]) => ({
                specId,
                value: values.join(" | "),
              })),
            }));
          })(),
          // Store product reference ID for syncing to SPF records
          productReferenceID: (rowProductRefIDs[rowIndex]?.[i] ?? "-") !== "-" ? rowProductRefIDs[rowIndex][i] : null,
          qty: originalQty,
          __originalQty: originalQty,
          __priceValidity: (() => {
            const pv = (rowPriceValidities[rowIndex] ?? [])[i];
            if (!pv || pv === "-") return "";
            try { return new Date(pv).toISOString().slice(0, 16); } catch { return ""; }
          })(),
          price_validity: (() => {
            const pv = (rowPriceValidities[rowIndex] ?? [])[i];
            if (!pv || pv === "-") return "";
            return pv;
          })(),
          __tdsBrand: (() => {
            const b = (rowTdsBrands[rowIndex] ?? [])[i];
            return b && b !== "-" ? b : "";
          })(),
          __tdsPdfUrl: (() => {
            const u = (rowTdsUrls[rowIndex] ?? [])[i];
            return u && u !== "-" ? u : "";
          })(),
          __tdsProductName: (() => {
            const n = (rowProductNames[rowIndex] ?? [])[i];
            return n && n !== "-" ? n : "";
          })(),
          __spfRemarksPD: spfRemarksPD[i] && spfRemarksPD[i] !== "-" ? spfRemarksPD[i] : "",
          dimensionalDrawing: (() => {
            const u = (rowDimensionalDrawings[rowIndex] ?? [])[i];
            return u && u !== "-" ? { url: u } : null;
          })(),
          illuminanceDrawing: (() => {
            const u = (rowIlluminanceDrawings[rowIndex] ?? [])[i];
            return u && u !== "-" ? { url: u } : null;
          })(),
        };
      });
    });

    // Store original unit costs for price update validation
    const origCosts: Record<string, number> = {};
    descs.forEach((_, rowIndex) => {
      const costs = rowUnitCosts[rowIndex] ?? [];
      costs.forEach((cost: string, i: number) => {
        const originalCost = Number(cost) || 0;
        origCosts[`${rowIndex}_${i}`] = originalCost;
      });
    });

    setProductOffers(initialOffers);
    setOriginalQuantities(origQtys);
    setOriginalUnitCosts(origCosts);
    
    // Fetch products for all revision types to show in right panel
    fetchProducts();
    
    // For existing products without original specs stored, fetch from Firebase
    const enrichProductsWithOriginalSpecs = async () => {
      if (draftInUseRef.current) return;
      const updatedOffers: Record<number, any[]> = {};
      for (const [rowIdx, products] of Object.entries(initialOffers)) {
        const rowIndex = parseInt(rowIdx);
        updatedOffers[rowIndex] = await Promise.all(
          products.map(async (prod) => {
            if (!prod.__isExisting) return prod;
            // Skip if already has original specs from Supabase
            if (prod.__originalTechnicalSpecifications?.length > 0) return prod;
            const originalSpecs = await fetchOriginalProductSpecs(prod.productName);
            if (originalSpecs) {
              return { 
                ...prod, 
                __originalTechnicalSpecifications: originalSpecs 
              };
            }
            return prod;
          })
        );
      }
      if (draftInUseRef.current) return;
      setProductOffers(updatedOffers);
    };
    
    // Run enrichment after initial load
    setTimeout(() => enrichProductsWithOriginalSpecs(), 0);
    
    setEditMode(true);
    setViewMode(false);
    setActiveTab("items");
    setActiveRowIndex(null);
    setPickerStep("list");
    setPendingProduct(null);
    setProductSearch("");
    setShowPipeModal(false);
    setPendingPipeProduct(null);
    setPendingPipeRowIndex(null);
    setDeletedOffers([]);
  };

  /* ── Helpers (edit mode) ── */
  const freezeSpecs = (product: any) => {
    const activeFilters = (window as any).__ACTIVE_FILTERS__ || [];
    if (!product.technicalSpecifications) return product;
    const frozenSpecs = product.technicalSpecifications.map((group: any) => ({
      ...group,
      specs: group.specs?.map((spec: any) => {
        const raw = spec.value || "";
        const values = raw
          .split("|")
          .map((v: string) => v.trim())
          .filter(Boolean);
        const unique = Array.from(new Set(values)) as string[];
        if (!activeFilters.length)
          return { ...spec, value: unique.join(" | ") };
        const filtered = unique.filter((v) => activeFilters.includes(v));
        return {
          ...spec,
          value: filtered.length ? filtered.join(" | ") : unique.join(" | "),
        };
      }),
    }));
    // Preserve __originalTechnicalSpecifications if it exists
    const originalSpecs = product.__originalTechnicalSpecifications || product.technicalSpecifications;
    return { 
      ...product, 
      technicalSpecifications: frozenSpecs,
      __originalTechnicalSpecifications: originalSpecs,
    };
  };

  /* ── Fetch original product specs by item code ── */
  const fetchOriginalProductSpecs = async (itemCode: string): Promise<any[] | null> => {
    if (!itemCode || itemCode === "-" || itemCode.startsWith("Option ")) return null;
    try {
      const q = query(
        collection(db, "products"),
        where("productName", "==", itemCode),
        where("isActive", "==", true),
        limit(1)
      );
      const snap = await getDocs(q);
      if (!snap.empty) {
        const product = snap.docs[0].data();
        return product.technicalSpecifications || null;
      }
      return null;
    } catch (e) {
      console.error("Failed to fetch original product specs:", e);
      return null;
    }
  };

  /* ── Add product to a row (shared logic after pipe check) ── */
  const addProductToRow = (rowIndex: number, product: any) => {
    setProductOffers((prev) => {
      const copy = { ...prev };
      copy[rowIndex] = [
        ...(copy[rowIndex] || []),
        { 
          ...product, 
          qty: product.qty ?? 1,
          __tdsProductName: product.__tdsProductName ?? product.productName ?? "",
          // Store original specs for editing later
          __originalTechnicalSpecifications: product.__originalTechnicalSpecifications || product.technicalSpecifications,
        },
      ];
      return copy;
    });
  };

  /* ── Intercept product before adding — check for pipes ── */
  const tryAddProduct = (rowIndex: number, product: any) => {
    const frozen = freezeSpecs(product);
    if (hasMultipleSpecValues(frozen)) {
      setPendingPipeProduct(frozen);
      setPendingPipeRowIndex(rowIndex);
      setShowPipeModal(true);
    } else {
      addProductToRow(rowIndex, frozen);
    }
  };

  const removeProduct = (rowIndex: number, productIndex: number) => {
    setProductOffers((prev) => {
      const copy = { ...prev };
      const arr = [...(copy[rowIndex] || [])];
      const productToRemove = arr[productIndex];
      
      // Track deleted offer if it's an existing product
      if (productToRemove && productToRemove.__isExisting) {
        setDeletedOffers((prevDeleted) => [
          ...prevDeleted,
          {
            ...productToRemove,
            __rowIndex: rowIndex,
            __productIndex: productIndex,
          },
        ]);
      }
      
      arr.splice(productIndex, 1);
      copy[rowIndex] = arr;
      return copy;
    });
  };

  /* ── Mobile: tap-to-add ── */
  const handleProductTap = (product: any) => {
    if (activeRowIndex === null) {
      toast.error("Select a row first before adding a product.");
      setActiveTab("items");
      return;
    }
    // Store original specs before freezing
    const productWithOriginalSpecs = {
      ...product,
      __originalTechnicalSpecifications: product.technicalSpecifications,
    };
    const frozen = freezeSpecs(productWithOriginalSpecs);
    if (hasMultipleSpecValues(frozen)) {
      // Capture activeRowIndex into pendingPipeRowIndex BEFORE any state update
      const rowIdx = activeRowIndex;
      setPendingPipeProduct(frozen);
      setPendingPipeRowIndex(rowIdx);
      setShowPipeModal(true);
      // Don't navigate away
    } else {
      setPendingProduct(frozen);
      setPickerStep("confirm");
    }
  };

  const confirmAddProduct = () => {
    if (activeRowIndex === null || !pendingProduct) return;
    addProductToRow(activeRowIndex, pendingProduct);
    setPendingProduct(null);
    setPickerStep("list");
    toast.success("Product added!");
  };

  const cancelConfirm = () => {
    setPendingProduct(null);
    setPickerStep("list");
  };

  /* ── MultipleSpecsDetected confirm ── */
  const handlePipeConfirm = (filteredProduct: any) => {
    if (pendingPipeRowIndex === null) return;
    addProductToRow(pendingPipeRowIndex, { ...filteredProduct, qty: 1 });
    toast.success("Product added!");
    setPendingPipeProduct(null);
    setPendingPipeRowIndex(null);
    setShowPipeModal(false);
    setPendingProduct(null);
    setPickerStep("list");
  };

  const handlePipeClose = () => {
    setPendingPipeProduct(null);
    setPendingPipeRowIndex(null);
    setShowPipeModal(false);
    setDraggedProduct(null);
    setShowTrash(false);
  };

  /* ── Add Button Click Handler ── */
  const handleAddButtonClick = (product: any) => {
    const descs = (requestData?.item_description || "")
      .split(",")
      .map((s) => s.trim());
    const itemCount = descs.length || 0;

    if (itemCount === 0) {
      toast.error("No items available. Please add items first.");
      return;
    }

    if (itemCount === 1) {
      // If only 1 item, add directly to row 0
      const productWithOriginalSpecs = {
        ...product,
        __originalTechnicalSpecifications: product.technicalSpecifications,
      };
      tryAddProduct(0, productWithOriginalSpecs);
    } else {
      // If multiple items, show row selection dialog
      const productWithOriginalSpecs = {
        ...product,
        __originalTechnicalSpecifications: product.technicalSpecifications,
      };
      setPendingRowSelectProduct(productWithOriginalSpecs);
      setShowRowSelectModal(true);
    }
  };

  /* ── Row Selection Confirm ── */
  const handleRowSelectConfirm = (selectedRowIndex: number) => {
    if (pendingRowSelectProduct === null) return;
    tryAddProduct(selectedRowIndex, pendingRowSelectProduct);
    toast.success(`Product added to row ${selectedRowIndex + 1}!`);
    setShowRowSelectModal(false);
    setPendingRowSelectProduct(null);
  };

  const handleRowSelectCancel = () => {
    setShowRowSelectModal(false);
    setPendingRowSelectProduct(null);
  };

  /* ── Load Draft ── */
  const handleLoadDraft = async () => {
    if (!spfNumber || isLoadingDraft) return;

    setIsLoadingDraft(true);
    try {
      const res = await fetch(`/api/request/spf-request-get-draft-api?spf_number=${spfNumber}`);
      const data = await res.json();

      if (data?.success && data?.hasDraft && data?.productOffers) {
        // Debug: Log loaded draft products
        console.log("[Edit SPF] Loaded draft products:", Object.entries(data.productOffers).flatMap(
          ([rowIndex, prods]: [string, any]) =>
            prods.map((p: any) => ({
              name: p.productName,
              brand: p?.supplier?.supplierBrand,
              isExisting: p.__isExisting,
              rowIndex: Number(rowIndex),
            }))
        ));

        draftInUseRef.current = true;
        // Set the product offers from draft
        setProductOffers(data.productOffers);
        // Switch to edit mode with draft loaded
        setViewMode(false);
        setEditMode(true);
        // Restore the saved timer start time from draft - timer continues running
        if (data.draft?.spf_creation_start_time) {
          setSpfCreationStartTime(data.draft.spf_creation_start_time);
          setTimerActive(true);
        }
        toast.success("Draft loaded successfully. Continue editing...");
      } else {
        toast.info("No draft found for this SPF request");
        setHasDraft(false);
      }
    } catch (err) {
      console.error("Error loading draft:", err);
      toast.error("Failed to load draft");
    } finally {
      setIsLoadingDraft(false);
    }
  };

/* ── Duplicate Product ── */
  const handleDuplicate = async () => {
    if (!duplicateTarget || !userId) return;
    setDuplicating(true);
    try {
      const productRef = doc(db, "products", duplicateTarget.id);
      const productSnap = await getDoc(productRef);
      if (productSnap.exists()) {
        const productData = productSnap.data();
        const originalName = productData.productName;
        const baseNameMatch = originalName.match(/^(.*?)\s*\(\d+\)$/);
        const baseName = baseNameMatch ? baseNameMatch[1] : originalName;
        const allProductsQuery = query(collection(db, "products"), where("isActive", "==", true));
        const allProductsSnap = await getDocs(allProductsQuery);
        const existingNumbers = new Set<number>();
        allProductsSnap.docs.forEach((d: any) => {
          const name = d.data().productName;
          if (!name) return;
          const match = name.match(new RegExp(`^${escapeRegExp(baseName)}\\s*\\((\\d+)\\)$`));
          if (match) existingNumbers.add(parseInt(match[1]));
        });
        let nextNumber = 2;
        while (existingNumbers.has(nextNumber)) nextNumber++;
        const newProductName = `${baseName} (${nextNumber})`;
        const newDocRef = await addDoc(collection(db, "products"), {
          ...productData,
          productName: newProductName,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        let userReferenceID = userId;
        try {
          const userRes = await fetch(`/api/users?id=${encodeURIComponent(userId)}`);
          if (userRes.ok) {
            const userData = await userRes.json();
            userReferenceID = userData?.ReferenceID || userId;
          }
        } catch (err) {
          console.error("Failed to fetch user referenceID:", err);
        }
        try {
          await logProductEvent({
            whatHappened: "Product Duplicated",
            productId: newDocRef.id,
            productReferenceID: productData.productReferenceID,
            productClass: productData.productClass,
            pricePoint: productData.pricePoint,
            brandOrigin: productData.brandOrigin,
            supplier: productData.supplier,
            categoryTypes: productData.categoryTypes,
            productFamilies: productData.productFamilies,
            mainImage: productData.mainImage,
            dimensionalDrawing: productData.dimensionalDrawing,
            illuminanceDrawing: productData.illuminanceDrawing,
            technicalSpecifications: productData.technicalSpecifications,
            referenceID: userReferenceID,
            userId: userId,
            extra: {
              originalProductId: duplicateTarget.id,
              originalProductName: originalName,
              newProductName,
            },
          });
        } catch (auditErr) {
          console.error("Audit log error for product duplication:", auditErr);
        }
        setDuplicateTarget(null);
        toast.success(`Duplicated as "${newProductName}"`);
      }
    } catch (err) {
      console.error("Error duplicating product:", err);
      toast.error("Failed to duplicate product");
    } finally {
      setDuplicating(false);
    }
  };

  /* ── Save Draft (Edit Mode) ── */
  const handleSaveDraft = async () => {
    if (!spfNumber || isSavingDraft) return;

    setIsSavingDraft(true);
    try {
      const allProducts = Object.entries(productOffers).flatMap(
        ([rowIndex, prods]) =>
          prods.map((p) => ({ 
            ...p, 
            __rowIndex: Number(rowIndex),
            __originalTechnicalSpecifications: p.__originalTechnicalSpecifications || p.technicalSpecifications,
            productReferenceID: p.productReferenceID || p.id || null,
          })),
      );

      const res = await fetch("/api/request/spf-request-save-draft-api", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          spf_number: spfNumber,
          item_code: data?.item_code,
          selectedProducts: allProducts,
          totalItemRows: requestData?.item_description?.split(",").length ?? 1,
          spf_creation_start_time: spfCreationStartTime,
          is_edit_mode: true,
          original_spf_number: null,
          userId,
        }),
      });

      if (!res.ok) {
        const errText = await res.text();
        console.error("Draft save error:", errText);
        toast.error("Failed to save draft");
        return;
      }

      const result = await res.json();
      if (result?.success) {
        setHasDraft(true);
        toast.success("Draft saved successfully");
      }
    } catch (err) {
      console.error("Draft save error:", err);
      toast.error("Failed to save draft");
    } finally {
      setIsSavingDraft(false);
    }
  };

  /* ── Submit edit ── */
  const handleSubmitEdit = async () => {
    if (isSubmitting) return; // Prevent double submission
    
    setIsSubmitting(true);
    const end = new Date().toISOString();
    setSpfCreationEndTime(end);
    setTimerActive(false);
    const descs = (requestData?.item_description || "")
      .split(",")
      .map((s) => s.trim());
    const totalRows = descs.length;

    for (let i = 0; i < totalRows; i++) {
      if (!productOffers[i] || productOffers[i].length === 0) {
        toast.error(`Item row ${i + 1} has no product selected`);
        setIsSubmitting(false);
        return;
      }
      for (let j = 0; j < productOffers[i].length; j++) {
        const prod = productOffers[i][j];
        if (!prod.__priceValidity || prod.__priceValidity.trim() === "") {
          toast.error(`Row ${i + 1}, Option ${j + 1}: Price Validity is required`);
          setIsSubmitting(false);
          return;
        }
        if (!prod.__tdsBrand || prod.__tdsBrand.trim() === "") {
          toast.error(`Row ${i + 1}, Option ${j + 1}: TDS Brand is required`);
          setIsSubmitting(false);
          return;
        }
        // Validate TDS PDF URL
        if (!prod.__tdsPdfUrl || prod.__tdsPdfUrl.trim() === "") {
          toast.error(`Row ${i + 1}, Option ${j + 1}: TDS PDF is required. Please generate TDS first.`);
          setIsSubmitting(false);
          return;
        }

        // Validate branch selection for products with multiple countries
        const availableCountries = prod.countries || [];
        if (availableCountries.length > 1) {
          const selectedBranch = prod.__selectedBranch;
          if (!selectedBranch || selectedBranch.trim() === "") {
            toast.error(`Row ${i + 1}, Option ${j + 1}: Branch selection is required (multiple countries available)`);
            setIsSubmitting(false);
            return;
          }
        }
      }
    }

    try {
      const allProducts = Object.entries(productOffers).flatMap(
        ([rowIndex, prods]) =>
          prods.map((p) => ({ 
            ...p, 
            __rowIndex: Number(rowIndex),
            // Include original specs for later editing
            __originalTechnicalSpecifications: p.__originalTechnicalSpecifications || p.technicalSpecifications,
            // Include product reference ID for syncing changes from Firebase
            productReferenceID: p.productReferenceID || p.id || null,
          })),
      );

      // Debug: Log products being sent
      console.log("[Edit SPF] Submitting products:", allProducts.length);
      console.log("[Edit SPF] Products:", allProducts.map((p: any) => ({
        name: p.productName,
        brand: p?.supplier?.supplierBrand,
        isExisting: p.__isExisting,
        rowIndex: p.__rowIndex,
      })));

      const res = await fetch("/api/request/spf-request-edit-api", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          spf_number: spfNumber,
          tsm: data?.tsm ?? null,
          manager: data?.manager ?? null,
          item_code: data?.item_code ?? null,
          totalItemRows: totalRows,
          selectedProducts: allProducts,
          deletedOffers: deletedOffers,
          spf_creation_start_time: spfCreationStartTime ?? null,
          spf_creation_end_time: end ?? null,
          userId: userId ?? null,
        }),
      });

      if (!res.ok) {
        const errText = await res.text();
        console.error("Edit API error:", errText);
        toast.error("Failed to update SPF");
        return;
      }

      const result = await res.json();
      if (result?.success) {
        toast.success(`SPF updated — ${result.version_label ?? ""}`);

        if (userId) {
          onSPFUpdated({
            userId,
            spfNumber: spfNumber,
            spfId: result.spfId || "",
            url: "/requests",
          });
        }

        setEditMode(false);
        setViewMode(false);
        fetchSPF();
        onRefresh?.();
      }
    } catch (err: any) {
      console.error("Submit edit error:", err);
      toast.error("Something went wrong while updating SPF");
    } finally {
      setIsSubmitting(false);
    }
  };

  /* ────────────────────────────────────────────────────────────── */
  /* COMPUTED VALUES (view mode)                                    */
  /* ────────────────────────────────────────────────────────────── */
  const isApproved = data?.status === "Approved By Procurement";
  const isForRevision = data?.status === "For Revision";
  const isPendingForProcurement = data?.status === "Pending For Procurement";
  const isCancelled = data?.status === "Cancelled";
  const canEditOffer = isForRevision || isPendingForProcurement || isApproved;
  const showProcurementRemarks = isApproved || isForRevision;

  const rowStructure = deriveRowStructure(data?.item_code);
  
  const rowImages = splitByRow(data?.product_offer_image, rowStructure);
  const rowQtys = splitByRow(data?.product_offer_qty, rowStructure);
  const rowUnitCosts = splitByRow(data?.product_offer_unit_cost, rowStructure);
  const rowPcsPerCartons = splitByRow(data?.product_offer_pcs_per_carton, rowStructure);
  const rowPackaging = splitByRow(data?.product_offer_packaging_details, rowStructure);
  const rowCommercialTypes = splitByRow(data?.commercial_type, rowStructure);
  const rowWarranties = splitByRow(data?.warranty, rowStructure);
  const rowFactories = splitByRow(data?.product_offer_factory_address, rowStructure);
  const rowPorts = splitByRow(data?.product_offer_port_of_discharge, rowStructure);
  const rowSubtotals = splitByRow(data?.product_offer_subtotal, rowStructure);
  const rowSupplierBrands = splitByRow(data?.supplier_brand, rowStructure);
  const rowBranches = splitByRow(data?.supplier_branch, rowStructure);
  const rowSpecs = splitSpecsByRow(data?.product_offer_technical_specification, rowStructure);
  const rowCompanyNames = splitByRow(data?.company_name, rowStructure);
  const rowContactNames = splitByRow(data?.contact_name, rowStructure);
  const rowContactNumbers = splitByRow(data?.contact_number, rowStructure);
  const rowLeadTimes = splitByRow(data?.proj_lead_time, rowStructure);
  const rowSellingCosts = splitByRow(data?.final_selling_cost, rowStructure);
  const rowFinalUnitCosts = splitByRow(data?.final_unit_cost, rowStructure);
  const rowFinalSubtotals = splitByRow(data?.final_subtotal, rowStructure);
  const rowItemCodes = splitByRow(data?.item_code, rowStructure);
  const rowPriceValidities = splitByRow(data?.price_validity, rowStructure);
  const rowTdsBrands = splitByRow(data?.tds, rowStructure);
  const rowTdsUrls = splitByRow(data?.tds, rowStructure);
  const rowDimensionalDrawings = splitByRow(data?.dimensional_drawing, rowStructure);
  const rowIlluminanceDrawings = splitByRow(data?.illuminance_drawing, rowStructure);
  const rowSpfRemarksPD = splitByRow(data?.spf_remarks_pd, rowStructure);
  const rowSpfRemarksProcurement = splitByRow(data?.spf_remarks_procurement, rowStructure);
  const rowProductNames = splitByRow((data as any)?.product_name, rowStructure);

  const itemDescriptions: string[] = (requestData?.item_description || "")
    .split(",")
    .map((s) => s.trim());
  const itemImages = (requestData?.item_photo || "")
    .split(",")
    .map((s) => s.trim());

  /* ════════════════════════════════════════════════════════════ */
  /* EDIT MODE — MOBILE                                          */
  /* ════════════════════════════════════════════════════════════ */
  const renderEditMobile = () => {
    // Determine which tabs to show based on revision type
    const showProductsTab = revisionType === "specs" || revisionType === "both";
    const tabs = showProductsTab 
      ? (["details", "items", "products"] as const)
      : (["details", "items"] as const);
    
    // Get revision type display label
    const getRevisionLabel = () => {
      switch (revisionType) {
        case "price": return { label: "Price Update", color: "bg-green-100 text-green-700 border-green-200" };
        case "specs": return { label: "Specs & Qty", color: "bg-blue-100 text-blue-700 border-blue-200" };
        case "both": return { label: "Full Edit", color: "bg-orange-100 text-orange-700 border-orange-200" };
        default: return { label: "Edit", color: "bg-gray-100 text-gray-700 border-gray-200" };
      }
    };
    const revisionBadge = getRevisionLabel();

    return (
    <>
      <DialogHeader className="px-4 pt-4 pb-2 border-b shrink-0">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <ForPoolingButton show={showPoolingButton} spfNumber={spfNumber} />
            <DialogTitle className="text-sm font-semibold truncate flex items-center gap-2">
              <Pencil size={14} className="text-orange-500" />
              Edit {spfNumber}
              <span className={`text-[9px] px-2 py-0.5 rounded border ${revisionBadge.color}`}>
                {revisionBadge.label}
              </span>
            </DialogTitle>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {hasDraft && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 text-xs rounded text-blue-600 border-blue-300 hover:bg-blue-50"
                onClick={handleLoadDraft}
                disabled={isLoadingDraft}
              >
                {isLoadingDraft ? "Loading..." : "Load Draft"}
              </Button>
            )}
            <input
              type="text"
              placeholder="Search..."
              value={productSearch}
              onChange={(e) => setProductSearch(e.target.value)}
              className="border px-2 py-1 text-xs w-27.5 rounded"
            />
            <Button
              type="button"
              size="icon"
              variant="outline"
              className="h-8 w-8 rounded"
              onClick={() => setOpenFilter((p) => !p)}
            >
              <Funnel size={14} />
            </Button>
            {showProductsTab && canAddProduct && (
              <Button
                type="button"
                size="sm"
                className="h-8 text-xs rounded"
                onClick={() => setOpenAddProduct(true)}
              >
                + Add
              </Button>
            )}
          </div>
        </div>

        {/* Tabs */}
        <div className="flex mt-2 border rounded overflow-hidden text-xs font-medium">
          {tabs.map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setActiveTab(tab)}
              className={`flex-1 py-1.5 capitalize transition-colors ${
                activeTab === tab
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:bg-muted/80"
              }`}
            >
              {tab}
            </button>
          ))}
        </div>

        {showProductsTab && activeTab === "products" && (
          <div
            className={`mt-1 text-[11px] px-2 py-1 rounded ${
              activeRowIndex !== null
                ? "bg-green-50 text-green-700"
                : "bg-yellow-50 text-yellow-700"
            }`}
          >
            {activeRowIndex !== null
              ? `Adding to: ${spfNumber}-${String(activeRowIndex + 1).padStart(3, "0")}`
              : "⚠ Tap a row in Items tab to select it first"}
          </div>
        )}

        {/* Speech balloon for revision remarks */}
        {data?.revision_remarks && (
          <div className="relative mt-2">
            <div className="relative bg-orange-50 border-2 border-orange-300 rounded-2xl px-4 py-3 shadow-sm">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-[10px] font-bold uppercase tracking-wide text-orange-600 bg-orange-200 px-2 py-0.5 rounded">
                  {data.revision_type || "Revision"}
                </span>
              </div>
              <p className="text-xs text-orange-800 font-medium leading-relaxed">
                {data.revision_remarks}
              </p>
              {/* Speech balloon tail */}
              <div className="absolute -top-2 left-6 w-4 h-4 bg-orange-50 border-t-2 border-l-2 border-orange-300 transform rotate-45"></div>
            </div>
          </div>
        )}
      </DialogHeader>

      <div className="flex-1 overflow-y-auto overscroll-contain">
        {/* DETAILS TAB */}
        {activeTab === "details" && (
          <div className="p-4 space-y-4">
            <CardDetails
              title="SPF Details"
              fields={[
                { label: "SPF Number", value: spfNumber },
                { label: "Status", value: getStatusLabel(data?.status) },
                { label: "Manager", value: data?.manager },
                { label: "Process By", value: processBy },
              ]}
            />
          </div>
        )}

        {/* ITEMS TAB */}
        {activeTab === "items" && (
          <div className="p-3 space-y-3">
            {itemDescriptions.map((desc, index) => {
              const isActive = activeRowIndex === index;
              const offers = productOffers[index] || [];
              return (
                <div
                  key={index}
                  className={`border rounded-lg overflow-hidden transition-all ${
                    isActive ? "border-orange-500 shadow-md" : "border-border"
                  }`}
                >
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => {
                      const nextActive = isActive ? null : index;
                      setActiveRowIndex(nextActive);
                      if (nextActive !== null) setActiveTab("products");
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        const nextActive = isActive ? null : index;
                        setActiveRowIndex(nextActive);
                        if (nextActive !== null) setActiveTab("products");
                      }
                    }}
                    className={`w-full flex items-center gap-3 p-3 cursor-pointer select-none ${
                      isActive ? "bg-orange-50" : "bg-muted/30"
                    }`}
                  >
                    <span
                      className={`shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-bold ${
                        isActive
                          ? "bg-orange-600 text-white"
                          : "bg-muted text-muted-foreground"
                      }`}
                    >
                      {index + 1}
                    </span>
                    {itemImages[index] ? (
                      <img
                        src={itemImages[index]}
                        className="w-10 h-10 object-contain rounded shrink-0"
                        alt=""
                      />
                    ) : (
                      <div className="w-10 h-10 bg-muted rounded shrink-0 flex items-center justify-center text-[10px] text-muted-foreground">
                        No img
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium line-clamp-2">
                        {desc.replace(/\|/g, " · ")}
                      </p>
                      <p className="text-[10px] text-gray-500 mt-0.5">
                        {(() => {
                          const qtys = (requestData?.item_qty || "").split(",").map((q) => q.trim());
                          return qtys[index] ? `Qty: ${qtys[index]}` : null;
                        })()}
                      </p>
                      <p
                        className={`text-[10px] mt-0.5 ${isActive ? "text-orange-600" : "text-muted-foreground"}`}
                      >
                        {isActive
                          ? "Selected — tap Products to add"
                          : `${offers.length} product${offers.length !== 1 ? "s" : ""} added`}
                      </p>
                    </div>
                    {isActive ? (
                      <ChevronUp
                        size={14}
                        className="text-orange-500 shrink-0"
                      />
                    ) : (
                      <ChevronDown
                        size={14}
                        className="text-muted-foreground shrink-0"
                      />
                    )}
                  </div>

                  {offers.length > 0 && (
                    <div className="border-t divide-y">
                      {offers.map((prod: any, i: number) => {
                        const unitCost =
                          prod?.commercialDetails?.unitCost || "-";
                        const productName = prod?.__tdsProductName ?? prod?.productName ?? "";
                        let commercialType = prod?.commercialDetails?.commercialType || "BASIC";

                        // Derive commercial type from product name if it contains "Lights (multiple)" or "Lights (single)"
                        if (productName) {
                          const productNameLower = productName.toLowerCase();
                          if (productNameLower.includes("lights (multiple)") || productNameLower.includes("light (multiple)")) {
                            commercialType = "LIGHT";
                          } else if (productNameLower.includes("lights (single)") || productNameLower.includes("light (single)")) {
                            commercialType = "LIGHT";
                          }
                        }

                        const useArrayInput = prod?.commercialDetails?.useArrayInput || false;
                        const totalUnitCost = prod?.commercialDetails?.totalUnitCost || 0;
                        const multiRows = prod?.commercialDetails?.multiRows || [];
                        const qty = prod.qty ?? 1;
                        const cost = Number(
                          prod?.commercialDetails?.unitCost || 0,
                        );
                        const subtotal = qty * cost;

                        const packagingData = prod?.commercialDetails?.packaging;
                        let packagingDisplay: React.ReactNode = "-";
                        let qtyCtnDisplay: React.ReactNode = "-";
                        let commercialTypeDisplay: React.ReactNode = "-";

                        // Determine commercial type display and packaging display based on type
                        if (commercialType === "BASIC") {
                          commercialTypeDisplay = "Basic";
                          if (packagingData) {
                            const length = packagingData.length || "-";
                            const width = packagingData.width || "-";
                            const height = packagingData.height || "-";
                            packagingDisplay = `${length} × ${width} × ${height}`;
                            qtyCtnDisplay = prod?.commercialDetails?.pcsPerCarton || "-";
                          }
                        } else if (commercialType === "LIGHT") {
                          // Check product name to determine if it should be Multiple or Single
                          let isMultiple = useArrayInput;
                          if (productName) {
                            const productNameLower = productName.toLowerCase();
                            if (productNameLower.includes("lights (multiple)") || productNameLower.includes("light (multiple)")) {
                              isMultiple = true;
                            } else if (productNameLower.includes("lights (single)") || productNameLower.includes("light (single)")) {
                              isMultiple = false;
                            }
                          }

                          if (isMultiple) {
                            // Light Multiple Dimension
                            commercialTypeDisplay = "Light (Multiple)";
                            // Packaging: Show item name, dimensions, and cost per row for each array row
                            packagingDisplay = (
                              <div className="space-y-1">
                                {multiRows.map((row: any, idx: number) => (
                                  <div key={idx} className="text-[8px] leading-tight">
                                    <div className="font-medium">{row.itemName || `Item ${idx + 1}`}</div>
                                    <div>{row.length || "-"} × {row.width || "-"} × {row.height || "-"}</div>
                                    <div className="text-gray-500">{row.unitCost?.toFixed(2) || "0.00"} USD</div>
                                  </div>
                                ))}
                              </div>
                            );
                            // Qty/Ctn: Show item name and qty/box for each row
                            qtyCtnDisplay = (
                              <div className="space-y-1">
                                {multiRows.map((row: any, idx: number) => (
                                  <div key={idx} className="text-[8px] leading-tight">
                                    <div className="font-medium">{row.itemName || `Item ${idx + 1}`}</div>
                                    <div>Qty: {row.qtyPerCarton || "-"}</div>
                                  </div>
                                ))}
                              </div>
                            );
                          } else {
                            // Light Single Dimension
                            commercialTypeDisplay = "Light (Single)";
                            // Packaging: Show length, width, height
                            if (packagingData) {
                              const length = packagingData.length || "-";
                              const width = packagingData.width || "-";
                              const height = packagingData.height || "-";
                              packagingDisplay = `${length} × ${width} × ${height}`;
                            }
                            // Qty/Ctn: Show qty/box
                            qtyCtnDisplay = prod?.commercialDetails?.pcsPerCarton || "-";
                          }
                        } else if (commercialType === "POLE") {
                          commercialTypeDisplay = "Pole";
                          // Pole: No packaging
                          packagingDisplay = "-";
                          qtyCtnDisplay = "-";
                        }
                        
                        const factory =
                          prod?.commercialDetails?.factoryAddress || "-";
                              const warranty =
                                prod?.commercialDetails?.warranty || "-";
                        const port =
                          prod?.commercialDetails?.portOfDischarge || "-";
                        const supplierBrand =
                          prod?.supplier?.supplierBrand ||
                          prod?.supplier?.supplierBrandName ||
                          "";

                        return (
                          <div
                            key={i}
                            className="p-3 flex gap-3 items-start"
                          >
                            {prod.mainImage?.url ? (
                              <img
                                src={prod.mainImage.url}
                                className="w-14 h-14 object-contain rounded shrink-0"
                                alt=""
                              />
                            ) : (
                              <div className="w-14 h-14 bg-muted rounded shrink-0 flex items-center justify-center text-[10px] text-muted-foreground">
                                No img
                              </div>
                            )}
                            <div className="flex-1 min-w-0 space-y-1">
                              <span className="inline-flex items-center text-[10px] font-semibold px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200 whitespace-nowrap">
                                Option {i + 1}
                                {supplierBrand && ` · ${supplierBrand}`}
                              </span>
                              <p className="text-xs font-medium line-clamp-1">
                                {prod.productName}
                              </p>
                              <div className="flex items-center gap-2">
                                <span className="text-[10px] text-muted-foreground">
                                  Qty
                                </span>
                                {revisionType === "price" ? (
                                  // Price update: Qty not editable, show as read-only
                                  <span className="text-xs font-medium">{prod.qty || 1}</span>
                                ) : (
                                  // Specs or Both: Qty editable with validation
                                  <input
                                    type="number"
                                    min={getMinQty(index, i)}
                                    className="border rounded px-2 py-0.5 text-xs w-16"
                                    value={prod.qty || 1}
                                    onChange={(e) => {
                                      const minQty = getMinQty(index, i);
                                      let qty = Number(e.target.value);
                                      if (qty < minQty) qty = minQty;
                                      setProductOffers((prev) => {
                                        const copy = { ...prev };
                                        const row = [...(copy[index] || [])];
                                        row[i] = { ...row[i], qty };
                                        copy[index] = row;
                                        return copy;
                                      });
                                    }}
                                  />
                                )}
                              </div>
                              {/* Unit Cost - editable for price/both, read-only for specs */}
                              {revisionType === "specs" ? (
                                <div className="flex items-center gap-2">
                                  <span className="text-[10px] text-muted-foreground">Unit Cost</span>
                                  <span className="text-xs font-medium">{commercialType === "LIGHT" && useArrayInput ? totalUnitCost : unitCost}</span>
                                </div>
                              ) : (
                                <div className="flex items-center gap-2">
                                  <span className="text-[10px] text-muted-foreground">Unit Cost</span>
                                  <input
                                    type="number"
                                    min={getMinUnitCost(index, i)}
                                    step="0.01"
                                    className="border rounded px-2 py-0.5 text-xs w-20"
                                    value={commercialType === "LIGHT" && useArrayInput ? totalUnitCost : (prod?.commercialDetails?.unitCost || "0")}
                                    onChange={(e) => {
                                      const minCost = getMinUnitCost(index, i);
                                      let cost = Number(e.target.value);
                                      if (cost < minCost) cost = minCost;
                                      setProductOffers((prev) => {
                                        const copy = { ...prev };
                                        const row = [...(copy[index] || [])];
                                        row[i] = { 
                                          ...row[i], 
                                          commercialDetails: {
                                            ...row[i].commercialDetails,
                                            unitCost: cost.toString()
                                          }
                                        };
                                        copy[index] = row;
                                        return copy;
                                      });
                                    }}
                                  />
                                </div>
                              )}
                              <div className="flex items-center gap-2 mt-1">
                                <span className="text-[10px] text-muted-foreground shrink-0">
                                  Price Validity
                                </span>
                                <input
                                  type="datetime-local"
                                  className="border rounded px-2 py-0.5 text-xs flex-1"
                                  value={prod.__priceValidity ?? ""}
                                  onChange={(e) => {
                                    setProductOffers((prev) => {
                                      const copy = { ...prev };
                                      const row = [...(copy[index] || [])];
                                      row[i] = { ...row[i], __priceValidity: e.target.value, price_validity: e.target.value };
                                      copy[index] = row;
                                      return copy;
                                    });
                                  }}
                                />
                              </div>
                                <div className="flex items-center gap-2 mt-1">
                                  <span className="text-[10px] text-muted-foreground shrink-0">TDS Brand</span>
                                  <select
                                    className="border rounded px-2 py-0.5 text-xs flex-1"
                                    value={prod.__tdsBrand ?? ""}
                                    onChange={(e) => {
                                      const brand = e.target.value;
                                      setProductOffers((prev) => {
                                        const copy = { ...prev };
                                        const row = [...(copy[index] || [])];
                                        row[i] = { ...row[i], __tdsBrand: brand };
                                        copy[index] = row;
                                        return copy;
                                      });
                                    }}
                                  >
                                    <option value="">-- Brand --</option>
                                    {["Lit", "Lumera", "Ecoshift"].map((b) => (
                                      <option key={b} value={b}>{b}</option>
                                    ))}
                                  </select>
                                </div>
                                <div className="flex flex-col gap-1 mt-1">
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setSelectedRowIndexForTDS(index);
                                      setSelectedOptionIndexForTDS(i);
                                      setSelectedProductForTDS({
                                        ...prod,
                                        itemCode: `${spfNumber}-${String(index + 1).padStart(3, "0")}`,
                                      });
                                      setTdsDialogOpen(true);
                                    }}
                                    className="text-[10px] bg-blue-50 text-blue-600 border border-blue-200 rounded px-2 py-1 hover:bg-blue-100"
                                  >
                                    Generate TDS
                                  </button>
                                  {prod.__tdsPdfUrl && (
                                    <a
                                      href={prod.__tdsPdfUrl}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="text-[10px] text-blue-600 underline"
                                    >
                                      View TDS
                                    </a>
                                  )}
                                </div>
                                <div className="text-[10px] text-muted-foreground mt-1">
                                  {packagingDisplay}
                                </div>
                                {warranty !== "-" && (
                                  <p className="text-[10px] text-muted-foreground truncate">
                                    Warranty: {warranty}
                                  </p>
                                )}
                              {factory !== "-" && (
                                <p className="text-[10px] text-muted-foreground truncate">
                                  Factory: {factory}
                                </p>
                              )}
                              {port !== "-" && (
                                <p className="text-[10px] text-muted-foreground truncate">
                                  Port: {port}
                                </p>
                              )}
                              {qty > 0 && (
                                <p className="text-xs font-semibold text-right">
                                  $
                                  {subtotal.toLocaleString("en-US", {
                                    minimumFractionDigits: 2,
                                    maximumFractionDigits: 2,
                                  })}
                                </p>
                              )}
                              <InlineSpecs
                                specs={prod.technicalSpecifications ?? []}
                              />
                              {/* Edit Specs Button for mobile - show when product has multiple spec values and revision type is specs or both */}
                              {(revisionType === "specs" || revisionType === "both") && hasMultipleSpecValues({ 
                                technicalSpecifications: prod.__originalTechnicalSpecifications || prod.technicalSpecifications 
                              }) && (
                                <button
                                  type="button"
                                  onClick={() => openSpecsRevision(index, i)}
                                  className="mt-2 px-2 py-1 text-[10px] bg-blue-50 text-blue-600 border border-blue-200 rounded hover:bg-blue-100 w-full"
                                >
                                  Edit Specs
                                </button>
                              )}
                            </div>
                            <button
                              type="button"
                              onClick={() => removeProduct(index, i)}
                              className="text-destructive/60 hover:text-destructive mt-0.5 shrink-0"
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* PRODUCTS TAB */}
        {activeTab === "products" && (
          <div className="p-3">
            {/* Confirm bottom sheet */}
            {pickerStep === "confirm" && pendingProduct && (
              <div className="fixed inset-0 z-50 bg-black/40 flex items-end">
                <div className="bg-background w-full rounded-t-2xl p-5 space-y-4 shadow-xl">
                  <p className="text-sm font-semibold">Add this product?</p>
                  <div className="flex gap-3 items-center">
                    {pendingProduct.mainImage?.url ? (
                      <img
                        src={pendingProduct.mainImage.url}
                        className="w-16 h-16 object-contain rounded shrink-0"
                        alt=""
                      />
                    ) : (
                      <div className="w-16 h-16 bg-muted rounded shrink-0" />
                    )}
                    <div className="min-w-0">
                      <p className="text-sm font-medium line-clamp-2">
                        {pendingProduct.productName}
                      </p>
                      {(pendingProduct?.supplier?.supplierBrand ||
                        pendingProduct?.supplier?.supplierBrandName) && (
                        <p className="text-xs text-blue-600 font-medium mt-0.5">
                          {pendingProduct.supplier.supplierBrand ||
                            pendingProduct.supplier.supplierBrandName}
                        </p>
                      )}
                      {activeRowIndex !== null && (
                        <p className="text-xs text-muted-foreground mt-0.5">
                          → {spfNumber}-
                          {String(activeRowIndex + 1).padStart(3, "0")}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      className="flex-1 rounded"
                      onClick={cancelConfirm}
                    >
                      Cancel
                    </Button>
                    <Button
                      type="button"
                      className="flex-1 rounded"
                      onClick={confirmAddProduct}
                    >
                      Confirm Add
                    </Button>
                  </div>
                </div>
              </div>
            )}

            {openFilter && (
              <div className="mb-3 border rounded-lg overflow-hidden h-[50vh]">
                <FilteringComponent
                  products={products}
                  onFilter={(filtered) => setFilteredProducts(filtered)}
                />
              </div>
            )}

            {loadingProducts ? (
              <p className="text-sm text-muted-foreground text-center py-8">
                Loading products...
              </p>
            ) : filteredProducts.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">
                No products found.
              </p>
            ) : (
              <div className="space-y-2">
                {/* Pagination controls */}
                {filteredProducts.length > PRODUCTS_PER_PAGE && (
                  <div className="flex justify-between items-center mb-4">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setProductPage(prev => Math.max(1, prev - 1))}
                      disabled={productPage === 1}
                    >
                      Previous
                    </Button>
                    <span className="text-sm text-muted-foreground">
                      Page {productPage} of {Math.ceil(filteredProducts.length / PRODUCTS_PER_PAGE)}
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setProductPage(prev => Math.min(Math.ceil(filteredProducts.length / PRODUCTS_PER_PAGE), prev + 1))}
                      disabled={productPage === Math.ceil(filteredProducts.length / PRODUCTS_PER_PAGE)}
                    >
                      Next
                    </Button>
                  </div>
                )}

                {/* Paginated products */}
                {filteredProducts
                  .slice((productPage - 1) * PRODUCTS_PER_PAGE, productPage * PRODUCTS_PER_PAGE)
                  .map((p) => {
                  const supplierBrand =
                    p?.supplier?.supplierBrand ||
                    p?.supplier?.supplierBrandName ||
                    "";
                  const supplierCo = p?.supplier?.company || "";
                  return (
                    <div
                      key={p.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => handleProductTap(p)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ")
                          handleProductTap(p);
                      }}
                      className="w-full text-left border rounded-lg overflow-hidden flex gap-3 p-3 hover:bg-muted/40 active:bg-muted transition-colors cursor-pointer select-none"
                    >
                      {p.mainImage?.url ? (
                        <img
                          src={p.mainImage.url}
                          className="w-14 h-14 object-contain rounded shrink-0"
                          alt={p.productName}
                        />
                      ) : (
                        <div className="w-14 h-14 bg-muted rounded shrink-0 flex items-center justify-center text-[10px] text-muted-foreground">
                          No img
                        </div>
                      )}
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-semibold line-clamp-2">
                          {p.productName}
                        </p>
                        {supplierBrand && (
                          <p className="text-xs font-semibold text-blue-600 mt-0.5 truncate">
                            {supplierBrand}
                          </p>
                        )}
                        {supplierCo && (
                          <p className="text-[10px] text-muted-foreground truncate">
                            {supplierCo}
                          </p>
                        )}
                        {p.commercialDetails?.unitCost && (
                          <p className="text-[10px] text-muted-foreground mt-0.5">
                            Unit cost: {p.commercialDetails.unitCost}
                          </p>
                        )}
                        {p.commercialDetails?.pcsPerCarton && (
                          <p className="text-[10px] text-muted-foreground mt-0.5">
                            Qty/Per Carton: {p.commercialDetails.pcsPerCarton}
                          </p>
                        )}
                        <InlineProductSpecs
                          specs={p.technicalSpecifications ?? []}
                        />
                      </div>
                      <div className="shrink-0 flex flex-col items-center gap-1">
                        <div
                          className={`w-8 h-8 rounded-full flex items-center justify-center transition-colors ${
                            activeRowIndex !== null
                              ? "bg-primary text-primary-foreground"
                              : "bg-muted text-muted-foreground"
                          }`}
                        >
                          <Plus size={16} />
                        </div>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setDuplicateTarget({ id: p.id, name: p.productName });
                          }}
                          className="w-8 h-8 rounded-full bg-white border flex items-center justify-center shadow"
                          title="Duplicate product"
                        >
                          <Copy size={14} className="text-green-600" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      <DialogFooter className="px-4 py-3 border-t shrink-0 flex-col gap-2">
        <div className="w-full">
          <SPFTimer
            isActive={timerActive}
            startTime={spfCreationStartTime}
            label="Edit SPF Timer"
            onStart={(v) => setSpfCreationStartTime(v)}
            onStop={(v) => setSpfCreationEndTime(v)}
            onTick={() => {}}
          />
        </div>
        <div className="w-full">
          <Button
            type="button"
            variant="secondary"
            className="w-full rounded"
            onClick={handleSaveDraft}
            disabled={isSavingDraft || itemDescriptions.length === 0}
          >
            <Save size={16} className="mr-2" />
            {isSavingDraft ? "Saving..." : hasDraft ? "Update Draft" : "Save Draft"}
          </Button>
        </div>
        <div className="w-full flex flex-row gap-2">
          <Button
            type="button"
            variant="outline"
            className="flex-1 rounded"
            onClick={() => {
              setEditMode(false);
              setViewMode(false);
            }}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="outline"
            className="flex-1 rounded"
            onClick={() => {
              setViewMode((p) => !p);
              if (!viewMode) setActiveTab("items");
            }}
          >
            {viewMode ? "Edit" : "Preview"}
          </Button>
          {viewMode && (
            <Button
              type="button"
              className="flex-1 rounded bg-orange-600 hover:bg-orange-700"
              onClick={handleSubmitEdit}
              disabled={
                isSubmitting ||
                itemDescriptions.length === 0 ||
                itemDescriptions.some(
                  (_, i) => !productOffers[i] || productOffers[i].length === 0,
                ) ||
                Object.values(productOffers).flat().some(
                  (p: any) => !p.__priceValidity?.trim() || !p.__tdsBrand?.trim() ||
                    !p.__tdsPdfUrl?.trim() ||
                    (p.countries?.length > 1 && !p.__selectedBranch?.trim())
                )
              }
            >
              {isSubmitting ? "Saving..." : "Save"}
            </Button>
          )}
        </div>
      </DialogFooter>

      {/* ── MultipleSpecsDetected — rendered as fixed bottom sheet (not nested Dialog) ── */}
      <MultipleSpecsDetected
        open={showPipeModal}
        onClose={handlePipeClose}
        product={pendingPipeProduct}
        onConfirm={pendingPipeOptionIndex !== null ? handleSpecsRevisionConfirm : handlePipeConfirm}
      />
    </>
  );
};

  /* ════════════════════════════════════════════════════════════ */
  /* EDIT MODE — DESKTOP                                         */
  /* ════════════════════════════════════════════════════════════ */
  const renderEditDesktop = () => {
    // Get revision type display label
    const getRevisionLabel = () => {
      switch (revisionType) {
        case "price": return { label: "Price Update", color: "bg-green-100 text-green-700 border-green-200" };
        case "specs": return { label: "Specs & Qty", color: "bg-blue-100 text-blue-700 border-blue-200" };
        case "both": return { label: "Full Edit", color: "bg-orange-100 text-orange-700 border-orange-200" };
        default: return { label: "Edit", color: "bg-gray-100 text-gray-700 border-gray-200" };
      }
    };
    const revisionBadge = getRevisionLabel();
    // Hide right product panel for price-only mode
    const showRightPanel = revisionType === "specs" || revisionType === "both";

    return (
    <div className="flex flex-col h-full overflow-hidden">
      <DialogHeader className="w-full mb-4 shrink-0">
        <div className="flex items-center justify-between gap-4">
          <div className="flex-1" />
          <div className="flex items-center justify-center gap-2 shrink-0">
            <ForPoolingButton show={showPoolingButton} spfNumber={spfNumber} />
            <DialogTitle className="flex items-center gap-2">
              <Pencil size={16} className="text-orange-500" />
              Edit SPF — {spfNumber}
              <span className={`text-xs px-2 py-0.5 rounded border ${revisionBadge.color}`}>
                {revisionBadge.label}
              </span>
            </DialogTitle>
          </div>
          <div className="flex-1 flex gap-2 items-center justify-end">
            {hasDraft && (
              <Button
                type="button"
                variant="outline"
                className="rounded-none p-6 text-blue-600 border-blue-300 hover:bg-blue-50"
                onClick={handleLoadDraft}
                disabled={isLoadingDraft}
              >
                <Save size={16} className="mr-2" />
                {isLoadingDraft ? "Loading..." : "Load Draft"}
              </Button>
            )}
            <input
              type="text"
              placeholder="Search product..."
              value={productSearch}
              onChange={(e) => setProductSearch(e.target.value)}
              className="border px-3 py-2 text-sm w-55"
            />
            <Button
              size="icon"
              variant="outline"
              className="rounded-none p-6"
              onClick={() => setOpenFilter((prev) => !prev)}
            >
              <Funnel size={16} />
            </Button>
            {showRightPanel && canAddProduct && (
              <Button
                className="rounded-none p-6"
                onClick={() => setOpenAddProduct(true)}
              >
                + Add Product
              </Button>
            )}
          </div>
        </div>

        {showTrash && (
          <div className="flex justify-center mt-3">
            <div
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => {
                if (!draggedProduct) return;
                if (draggedProduct.__fromRow !== undefined) {
                  // Track deleted offer if it's an existing product
                  if (draggedProduct.__isExisting) {
                    setDeletedOffers((prevDeleted) => [
                      ...prevDeleted,
                      {
                        ...draggedProduct,
                        __rowIndex: draggedProduct.__fromRow,
                        __productIndex: draggedProduct.__fromIndex,
                      },
                    ]);
                  }
                  setProductOffers((prev) => {
                    const copy = { ...prev };
                    const arr = [...(copy[draggedProduct.__fromRow] || [])];
                    arr.splice(draggedProduct.__fromIndex, 1);
                    copy[draggedProduct.__fromRow] = arr;
                    return copy;
                  });
                }
                setDraggedProduct(null);
                setShowTrash(false);
              }}
              className="flex items-center gap-2 border border-dashed border-destructive/40 text-destructive text-xs px-4 py-2 rounded-md bg-muted/40 hover:bg-destructive/10 transition-colors cursor-pointer"
            >
              🗑 <span className="font-medium">Drag here to delete</span>
            </div>
          </div>
        )}

        {/* Speech balloon for revision remarks */}
        {data?.revision_remarks && (
          <div className="relative mt-3 mx-auto max-w-md">
            <div className="relative bg-orange-50 border-2 border-orange-300 rounded-2xl px-4 py-3 shadow-sm">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-[10px] font-bold uppercase tracking-wide text-orange-600 bg-orange-200 px-2 py-0.5 rounded">
                  {data.revision_type || "Revision"}
                </span>
              </div>
              <p className="text-xs text-orange-800 font-medium leading-relaxed">
                {data.revision_remarks}
              </p>
              {/* Speech balloon tail */}
              <div className="absolute -top-2 left-1/2 -translate-x-1/2 w-4 h-4 bg-orange-50 border-t-2 border-l-2 border-orange-300 transform rotate-45"></div>
            </div>
          </div>
        )}
      </DialogHeader>

      <div className="flex gap-4 overflow-hidden flex-1">
        {/* LEFT: Items table */}
        <Card
          className={`${viewMode ? "w-full" : "w-[70%]"} transition-all duration-500 ease-in-out p-4 flex flex-col gap-4 overflow-y-auto overscroll-contain`}
        >
          <div className="mb-3 border-b pb-2">
            <h3 className="text-sm font-bold">{spfNumber}</h3>
          </div>

<div className="space-y-4">
  {itemDescriptions.length ? (
    itemDescriptions.map((desc, index) => (
      <div
        key={`row-${index}`}
        className="flex gap-3 border rounded-lg overflow-hidden"
        onDragOver={(e) => e.preventDefault()}
        onDrop={() => {
          if (!draggedProduct) return;
          const frozen =
            draggedProduct.__fromRow !== undefined
              ? draggedProduct
              : freezeSpecs(draggedProduct);
          if (hasMultipleSpecValues(frozen)) {
            if (draggedProduct.__fromRow !== undefined) {
              setProductOffers((prev) => {
                const copy = { ...prev };
                const original = [...(copy[draggedProduct.__fromRow] || [])];
                original.splice(draggedProduct.__fromIndex, 1);
                copy[draggedProduct.__fromRow] = original;
                return copy;
              });
            }
            setPendingPipeProduct(frozen);
            setPendingPipeRowIndex(index);
            setShowPipeModal(true);
            setDraggedProduct(null);
            setShowTrash(false);
          } else {
            setProductOffers((prev) => {
              const copy = { ...prev };
              if (draggedProduct.__fromRow !== undefined) {
                const original = [...(copy[draggedProduct.__fromRow] || [])];
                original.splice(draggedProduct.__fromIndex, 1);
                copy[draggedProduct.__fromRow] = original;
              }
              copy[index] = [
                ...(copy[index] || []),
                { ...frozen, qty: frozen.qty ?? 1, __tdsProductName: frozen.__tdsProductName ?? frozen.productName ?? "" },
              ];
              return copy;
            });
            setDraggedProduct(null);
          }
        }}
      >
        {/* LEFT: Item Info Panel */}
        <div className="w-[220px] shrink-0 bg-green-50 border-r p-3 flex flex-col gap-2">
          <div className="text-[10px] font-bold text-gray-500 uppercase tracking-wide">
            Item {index + 1}
          </div>
          <div className="text-[11px] font-semibold text-gray-700 font-mono bg-white border px-2 py-1 rounded">
            {`${spfNumber}-${String(index + 1).padStart(3, "0")}`}
          </div>
          {itemImages[index] ? (
            <img
              src={itemImages[index]}
              alt={desc}
              className="w-full h-28 object-contain cursor-pointer hover:opacity-80 transition-opacity rounded border bg-white"
              onClick={() => openImagePreview(itemImages[index])}
            />
          ) : (
            <div className="w-full h-28 bg-white border rounded flex items-center justify-center text-[10px] text-gray-400">
              No Image
            </div>
          )}
          <div>
            <div className="text-[9px] text-gray-400 uppercase font-semibold mb-0.5">Item Qty</div>
            <div className="text-[11px] font-medium text-gray-700">
              {(() => {
                const qtys = (requestData?.item_qty || "").split(",").map((q: string) => q.trim());
                return qtys[index] || "-";
              })()}
            </div>
          </div>
          <div>
            <div className="text-[9px] text-gray-400 uppercase font-semibold mb-0.5">Description</div>
            <div className="text-[10px] text-gray-700 leading-snug whitespace-pre-wrap">
              {desc.replace(/\|/g, "\n")}
            </div>
          </div>
        </div>

        {/* RIGHT: Product Offers */}
        <div className="flex-1 p-3 overflow-x-auto">
          {(productOffers[index] || []).length === 0 ? (
            <div className="h-full flex items-center justify-center text-[11px] text-gray-400 border-2 border-dashed rounded-lg min-h-[120px]">
              Drag a product here or use the + button
            </div>
          ) : (
            <div className="flex gap-3">
              {(productOffers[index] || []).map((prod: any, i: number) => {
                const cardKey = `${index}-${i}`;
                const isExpanded = expandedProductCards[cardKey] || false;
                const unitCost = prod?.commercialDetails?.unitCost || "-";
                const productName = prod?.__tdsProductName ?? prod?.productName ?? "";
                let commercialType = prod?.commercialDetails?.commercialType || "BASIC";
                if (productName) {
                  const n = productName.toLowerCase();
                  if (n.includes("lights (multiple)") || n.includes("light (multiple)")) commercialType = "LIGHT";
                  else if (n.includes("lights (single)") || n.includes("light (single)")) commercialType = "LIGHT";
                }
                const useArrayInput = prod?.commercialDetails?.useArrayInput || false;
                const totalUnitCost = prod?.commercialDetails?.totalUnitCost || 0;
                const multiRows = prod?.commercialDetails?.multiRows || [];
                const packagingData = prod?.commercialDetails?.packaging;
                let packagingDisplay: React.ReactNode = "-";
                let qtyCtnDisplay: React.ReactNode = "-";
                let commercialTypeDisplay: React.ReactNode = "-";
                if (commercialType === "BASIC") {
                  commercialTypeDisplay = "Basic";
                  if (packagingData) {
                    packagingDisplay = `${packagingData.length || "-"} × ${packagingData.width || "-"} × ${packagingData.height || "-"}`;
                    qtyCtnDisplay = prod?.commercialDetails?.pcsPerCarton || "-";
                  }
                } else if (commercialType === "LIGHT") {
                  let isMultiple = useArrayInput;
                  if (productName) {
                    const n = productName.toLowerCase();
                    if (n.includes("lights (multiple)") || n.includes("light (multiple)")) isMultiple = true;
                    else if (n.includes("lights (single)") || n.includes("light (single)")) isMultiple = false;
                  }
                  if (isMultiple) {
                    commercialTypeDisplay = "Light (Multiple)";
                    packagingDisplay = (
                      <div className="space-y-1">
                        {multiRows.map((row: any, idx: number) => (
                          <div key={idx} className="text-[8px] leading-tight">
                            <div className="font-medium">{row.itemName || `Item ${idx + 1}`}</div>
                            <div>{row.length || "-"} × {row.width || "-"} × {row.height || "-"}</div>
                            <div className="text-gray-500">{row.unitCost?.toFixed(2) || "0.00"} USD</div>
                          </div>
                        ))}
                      </div>
                    );
                    qtyCtnDisplay = (
                      <div className="space-y-1">
                        {multiRows.map((row: any, idx: number) => (
                          <div key={idx} className="text-[8px] leading-tight">
                            <div className="font-medium">{row.itemName || `Item ${idx + 1}`}</div>
                            <div>Qty: {row.qtyPerCarton || "-"}</div>
                          </div>
                        ))}
                      </div>
                    );
                  } else {
                    commercialTypeDisplay = "Light (Single)";
                    if (packagingData) packagingDisplay = `${packagingData.length || "-"} × ${packagingData.width || "-"} × ${packagingData.height || "-"}`;
                    qtyCtnDisplay = prod?.commercialDetails?.pcsPerCarton || "-";
                  }
                } else if (commercialType === "POLE") {
                  commercialTypeDisplay = "Pole";
                  packagingDisplay = "-";
                  qtyCtnDisplay = "-";
                }
                const factory = prod?.commercialDetails?.factoryAddress || "-";
                const warranty = prod?.commercialDetails?.warranty || "-";
                const port = prod?.commercialDetails?.portOfDischarge || "-";
                const availableCountries = prod.countries || [];
                const selectedBranch = prod.__selectedBranch || (availableCountries.length === 1 ? availableCountries[0] : "");
                const qty = prod.qty ?? 1;
                const cost = Number(prod.commercialDetails?.unitCost || 0);
                const subtotal = (qty * cost).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

                return (
                  <div
                    key={i}
                    draggable
                    className="relative border rounded-lg shadow-sm hover:shadow-md transition-shadow cursor-grab active:cursor-grabbing bg-white shrink-0 w-[280px] flex flex-col"
                    onDragStart={(e) => {
                      e.dataTransfer.setData("text/plain", "dragging");
                      setDraggedProduct({ ...prod, __fromRow: index, __fromIndex: i });
                      setShowTrash(true);
                    }}
                    onDragEnd={() => {
                      setDraggedProduct(null);
                      setShowTrash(false);
                    }}
                  >
                    {/* Header bar */}
                    <div className="flex items-center justify-between px-3 py-2 bg-blue-600 rounded-t-lg">
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => setExpandedProductCards((prev) => ({ ...prev, [cardKey]: !prev[cardKey] }))}
                          className="text-white/80 hover:text-white"
                        >
                          {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                        </button>
                        <span className="text-[11px] font-semibold text-white">
                          {prod?.supplier?.supplierBrand || prod?.supplier?.supplierBrandName || `Option ${i + 1}`}
                        </span>
                      </div>
                      <div className="flex items-center gap-1">
                        <span className="text-[10px] text-white/70 font-mono">Offer #{i + 1}</span>
                        <button
                          type="button"
                          onClick={() => removeProduct(index, i)}
                          className="ml-1 text-white/70 hover:text-red-300"
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </div>

                    {/* Product image */}
                    <div className="flex justify-center px-3 pt-3">
                      {prod.mainImage?.url ? (
                        <img
                          src={prod.mainImage.url}
                          className="w-24 h-24 object-contain cursor-pointer hover:opacity-80 transition-opacity"
                          alt=""
                          onClick={() => openImagePreview(prod.mainImage?.url)}
                        />
                      ) : (
                        <div className="w-24 h-24 bg-gray-100 flex items-center justify-center text-[10px] text-gray-400 rounded">
                          No Image
                        </div>
                      )}
                    </div>

                    {/* Product name */}
                    <div className="px-3 pt-2 pb-1">
                      <input
                        disabled
                        value={productName}
                        className="w-full border rounded px-2 py-1 text-[10px] text-center font-medium"
                        placeholder="Product name"
                      />
                    </div>

                    {/* Core fields */}
                    <div className="px-3 pb-2 space-y-1.5 text-[10px]">
                      <div className="grid grid-cols-2 gap-1.5">
                        <div>
                          <div className="text-gray-400 mb-0.5">Branch</div>
                          {availableCountries.length === 0 ? (
                            <span className="font-medium">-</span>
                          ) : availableCountries.length === 1 ? (
                            <span className="font-medium">{availableCountries[0]}</span>
                          ) : (
                            <select
                              className="border rounded px-1 py-0.5 text-[8px] w-full"
                              value={selectedBranch}
                              onChange={(e) => {
                                const branch = e.target.value;
                                setProductOffers((prev) => {
                                  const copy = { ...prev };
                                  const row = [...(copy[index] || [])];
                                  row[i] = { ...row[i], __selectedBranch: branch };
                                  copy[index] = row;
                                  return copy;
                                });
                              }}
                            >
                              <option value="">-- Select --</option>
                              {availableCountries.map((country: string) => (
                                <option key={country} value={country}>{country}</option>
                              ))}
                            </select>
                          )}
                        </div>
                        <div>
                          <div className="text-gray-400 mb-0.5">Qty</div>
                          {revisionType === "price" ? (
                            <span className="font-medium">{prod.qty || 1}</span>
                          ) : (
                            <input
                              type="number"
                              min={getMinQty(index, i)}
                              className="w-full border rounded px-1 py-0.5 text-[10px]"
                              value={prod.qty || 1}
                              onChange={(e) => {
                                const minQty = getMinQty(index, i);
                                let qty = Number(e.target.value);
                                if (qty < minQty) qty = minQty;
                                setProductOffers((prev) => {
                                  const copy = { ...prev };
                                  const row = [...(copy[index] || [])];
                                  row[i] = { ...row[i], qty };
                                  copy[index] = row;
                                  return copy;
                                });
                              }}
                            />
                          )}
                        </div>
                        <div>
                          <div className="text-gray-400 mb-0.5">Unit Cost</div>
                          {revisionType === "specs" ? (
                            <span className="font-medium">{commercialType === "LIGHT" && useArrayInput ? totalUnitCost : unitCost}</span>
                          ) : (
                            <input
                              type="number"
                              min={getMinUnitCost(index, i)}
                              step="0.01"
                              className="w-full border rounded px-1 py-0.5 text-[10px]"
                              value={commercialType === "LIGHT" && useArrayInput ? totalUnitCost : (prod?.commercialDetails?.unitCost || "0")}
                              onChange={(e) => {
                                const minCost = getMinUnitCost(index, i);
                                let cost = Number(e.target.value);
                                if (cost < minCost) cost = minCost;
                                setProductOffers((prev) => {
                                  const copy = { ...prev };
                                  const row = [...(copy[index] || [])];
                                  row[i] = { ...row[i], commercialDetails: { ...row[i].commercialDetails, unitCost: cost.toString() } };
                                  copy[index] = row;
                                  return copy;
                                });
                              }}
                            />
                          )}
                        </div>
                        <div>
                          <div className="text-gray-400 mb-0.5">Subtotal</div>
                          <div className="font-semibold text-gray-800">${subtotal}</div>
                        </div>
                      </div>

                      {/* Price Validity */}
                      <div>
                        <div className="text-gray-400 mb-0.5">Price Validity</div>
                        <input
                          type="datetime-local"
                          className="w-full border rounded px-1 py-0.5 text-[10px]"
                          value={prod.__priceValidity ?? ""}
                          onChange={(e) => {
                            setProductOffers((prev) => {
                              const copy = { ...prev };
                              const row = [...(copy[index] || [])];
                              row[i] = { ...row[i], __priceValidity: e.target.value, price_validity: e.target.value };
                              copy[index] = row;
                              return copy;
                            });
                          }}
                        />
                      </div>

                      {/* TDS Brand */}
                      <div>
                        <div className="text-gray-400 mb-0.5">TDS Brand</div>
                        <select
                          className="w-full border rounded px-1 py-0.5 text-[10px]"
                          value={prod.__tdsBrand ?? ""}
                          onChange={(e) => {
                            const brand = e.target.value;
                            setProductOffers((prev) => {
                              const copy = { ...prev };
                              const row = [...(copy[index] || [])];
                              row[i] = { ...row[i], __tdsBrand: brand };
                              copy[index] = row;
                              return copy;
                            });
                          }}
                        >
                          <option value="">-- Brand --</option>
                          {["Lit", "Lumera", "Ecoshift"].map((b) => (
                            <option key={b} value={b}>{b}</option>
                          ))}
                        </select>
                        <button
                          type="button"
                          className="mt-1 text-[10px] text-green-600 underline"
                          onClick={() => {
                            const rowBase = `${spfNumber}-${String(index + 1).padStart(3, "0")}`;
                            const optionIndexToLetters = (idx: number) => {
                              let n = idx; let s = "";
                              while (n >= 0) { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; }
                              return s;
                            };
                            const rowOffers = productOffers[index] || [];
                            const itemCode = rowOffers.length > 1 ? `${rowBase}-${optionIndexToLetters(i)}` : rowBase;
                            setSelectedRowIndexForTDS(index);
                            setSelectedOptionIndexForTDS(i);
                            setSelectedProductForTDS({ ...prod, itemCode });
                            setTdsDialogOpen(true);
                          }}
                        >
                          Generate TDS
                        </button>
                        {prod.__tdsPdfUrl && (
                          <a href={prod.__tdsPdfUrl} target="_blank" rel="noopener noreferrer" className="mt-0.5 text-[10px] text-blue-600 underline block">
                            View TDS
                          </a>
                        )}
                      </div>
                    </div>

                    {/* Expandable details */}
                    {isExpanded && (
                      <div className="border-t mx-3 pt-2 pb-3 space-y-2 text-[10px]">
                        {/* Technical Specs */}
                        <div>
                          <div className="text-gray-400 font-semibold mb-1">Technical Specs</div>
                          <div className="space-y-1">
                            {prod.technicalSpecifications
                              ?.map((g: any) => ({ ...g, specs: g.specs?.filter((s: any) => s.value?.trim()) }))
                              .filter((g: any) => g.specs?.length > 0)
                              .map((g: any, gi: number) => (
                                <div key={gi}>
                                  <b className="text-[9px]">{g.title}</b>
                                  {g.specs.map((s: any, si: number) => (
                                    <div key={si} className="text-[9px] text-gray-600">{s.specId}: {s.value}</div>
                                  ))}
                                </div>
                              ))}
                            {(revisionType === "specs" || revisionType === "both") && hasMultipleSpecValues({
                              technicalSpecifications: prod.__originalTechnicalSpecifications || prod.technicalSpecifications
                            }) && (
                              <button
                                type="button"
                                onClick={() => openSpecsRevision(index, i)}
                                className="mt-1 px-2 py-1 text-[10px] bg-blue-50 text-blue-600 border border-blue-200 rounded hover:bg-blue-100"
                              >
                                Edit Specs
                              </button>
                            )}
                          </div>
                        </div>

                        {/* Commercial Details */}
                        <div className="grid grid-cols-2 gap-1.5">
                          <div><div className="text-gray-400">Qty/Ctn</div><div>{qtyCtnDisplay}</div></div>
                          <div><div className="text-gray-400">Comm. Type</div><div>{commercialTypeDisplay}</div></div>
                          <div><div className="text-gray-400">Packaging</div><div>{packagingDisplay}</div></div>
                          <div><div className="text-gray-400">Warranty</div><div>{warranty}</div></div>
                          <div><div className="text-gray-400">Factory</div><div className="truncate">{factory}</div></div>
                          <div><div className="text-gray-400">Port</div><div>{port}</div></div>
                        </div>

                        {/* PD Remarks */}
                        <div>
                          <div className="text-gray-400 mb-0.5">PD Remarks</div>
                          <textarea
                            className="w-full border rounded px-1 py-0.5 text-[8px] resize-none"
                            rows={2}
                            placeholder="Remarks..."
                            value={prod.__spfRemarksPD || ""}
                            onChange={(e) => {
                              setProductOffers((prev) => {
                                const copy = { ...prev };
                                const row = [...(copy[index] || [])];
                                row[i] = { ...row[i], __spfRemarksPD: e.target.value };
                                copy[index] = row;
                                return copy;
                              });
                            }}
                          />
                        </div>

                        {showProcurementRemarks && (
                          <div>
                            <div className="text-gray-400 mb-0.5">Procurement Remarks</div>
                            <div className="text-[9px]">{prod.__spfRemarksProcurement || "-"}</div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    ))
  ) : (
    <p className="text-sm text-muted-foreground">No items.</p>
  )}
</div>
        </Card>

        {/* RIGHT: Draggable product cards */}
        <div
          className={`transition-all duration-500 ease-in-out ${
            viewMode
              ? "opacity-0 w-0 overflow-hidden pointer-events-none"
              : "opacity-100 w-[30%]"
          } overflow-y-auto overscroll-contain`}
        >
          {/* Pagination controls for desktop */}
          {filteredProducts.length > PRODUCTS_PER_PAGE && (
            <div className="flex justify-between items-center mb-4 sticky top-0 bg-background z-10 p-2 border-b">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setProductPage(prev => Math.max(1, prev - 1))}
                disabled={productPage === 1}
              >
                Previous
              </Button>
              <span className="text-sm text-muted-foreground">
                Page {productPage} of {Math.ceil(filteredProducts.length / PRODUCTS_PER_PAGE)}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setProductPage(prev => Math.min(Math.ceil(filteredProducts.length / PRODUCTS_PER_PAGE), prev + 1))}
                disabled={productPage === Math.ceil(filteredProducts.length / PRODUCTS_PER_PAGE)}
              >
                Next
              </Button>
            </div>
          )}

          <div className="columns-2 gap-3">
            {filteredProducts
              .slice((productPage - 1) * PRODUCTS_PER_PAGE, productPage * PRODUCTS_PER_PAGE)
              .map((p) => (
              <Card
                key={p.id}
                draggable
                onDragStart={() => {
                  setDraggedProduct({ 
                    ...p, 
                    __fromRow: undefined,
                    __originalTechnicalSpecifications: p.technicalSpecifications,
                  });
                  setShowTrash(true);
                }}
                onDragEnd={() => {
                  setDraggedProduct(null);
                  setShowTrash(false);
                }}
className="relative flex flex-col p-2 border shadow hover:shadow-md break-inside-avoid mb-3 cursor-grab"
>
  {/* 🔥 ADD BUTTON - Top Left */}
  <button
    type="button"
    onClick={(e) => {
      e.stopPropagation();
      handleAddButtonClick(p);
    }}
    className="absolute top-2 left-2 z-10 bg-white border rounded-full p-1 hover:bg-gray-100 shadow"
    title="Add to row"
  >
    <Plus size={14} className="text-green-600" />
  </button>

  {/* 🔥 DUPLICATE BUTTON */}
  <button
    type="button"
    onClick={(e) => {
      e.stopPropagation();
      setDuplicateTarget({ id: p.id, name: p.productName });
    }}
    className="absolute top-2 right-10 z-10 bg-white border rounded-full p-1 hover:bg-gray-100 shadow"
    title="Duplicate product"
  >
    <Copy size={14} className="text-green-600" />
  </button>

  {/* 🔥 EDIT BUTTON */}
{canEditProduct && (
  <button
    type="button"
    onClick={(e) => {
      e.stopPropagation();
      setSelectedProduct(p);
      setOpenEditProduct(true);
    }}
    className="absolute top-2 right-2 z-10 bg-white border rounded-full p-1 hover:bg-gray-100 shadow"
  >
    <Pencil size={14} className="text-orange-500" />
  </button>
)}
                <div className="h-25 w-full bg-gray-100 flex items-center justify-center overflow-hidden rounded">
                  {p.mainImage?.url ? (
                    <img
                      src={p.mainImage.url}
                      className="w-full h-full object-contain"
                      alt={p.productName}
                    />
                  ) : (
                    <div className="text-xs text-gray-400">No Image</div>
                  )}
                </div>
                <div className="mt-2 flex-1">
                  <p className="text-sm font-semibold line-clamp-2">
                    {p.productName}
                  </p>
                  {(p?.supplier?.supplierBrand ||
                    p?.supplier?.supplierBrandName) && (
                    <p className="text-xs font-semibold text-blue-600 mt-0.5 truncate">
                      {p?.supplier?.supplierBrand || p?.supplier?.supplierBrandName}
                    </p>
                  )}
                </div>
                <Accordion
                  type="single"
                  collapsible
                  className="mt-2 border rounded"
                >
                  <AccordionItem value="commercial">
                    <AccordionTrigger className="px-3 text-xs">
                      Commercial Details
                    </AccordionTrigger>
                    <AccordionContent className="px-3 pb-3 text-xs space-y-2">
                      {(() => {
                        const details = p.commercialDetails;
                        if (!details) return <p>-</p>;
                        const packaging = details.packaging || {};
                        return (
                          <>
                            {details.factoryAddress && (
                              <p>
                                <span className="font-medium">Factory:</span>{" "}
                                {details.factoryAddress}
                              </p>
                            )}
                            {details.portOfDischarge && (
                              <p>
                                <span className="font-medium">Port:</span>{" "}
                                {details.portOfDischarge}
                              </p>
                            )}
                            {details.unitCost && (
                              <p>
                                <span className="font-medium">Unit Cost:</span>{" "}
                                {details.unitCost}
                              </p>
                            )}
                            {(() => {
                              return (
                                <>
                                  {details.pcsPerCarton && (
                                    <p>
                                      <span className="font-medium">Qty/Per Carton:</span>{" "}{details.pcsPerCarton}
                                      {details.pcsPerCarton}
                                    </p>
                                  )}
                                  {(packaging.height || packaging.length || packaging.width) && (
                                    <div>
                                      <p className="font-medium">Packaging</p>
                                      <ul className="ml-3 list-disc">
                                        {packaging.height && <li>Height: {packaging.height}</li>}
                                        {packaging.length && <li>Length: {packaging.length}</li>}
                                        {packaging.width && <li>Width: {packaging.width}</li>}
                                      </ul>
                                    </div>
                                  )}
                                </>
                              );
                            })()}
                          </>
                        );
                      })()}
                    </AccordionContent>
                  </AccordionItem>
                  <AccordionItem value="technical">
                    <AccordionTrigger className="px-3 text-xs">
                      Technical Specifications
                    </AccordionTrigger>
                    <AccordionContent className="px-3 pb-3 text-xs space-y-2">
                      {p.technicalSpecifications?.length ? (
                        p.technicalSpecifications
                          .filter((g: any) => g.title !== "COMMERCIAL DETAILS")
                          .map((group: any, i: number) => (
                            <div key={i} className="mb-3">
                              <p className="font-semibold">{group.title}</p>
                              <ul className="ml-3 list-disc">
                                {group.specs.map((spec: any, s: number) => (
                                  <li key={s}>
                                    <span className="font-medium">
                                      {spec.specId}
                                    </span>{" "}
                                    : {spec.value || "-"}
                                  </li>
                                ))}
                              </ul>
                            </div>
                          ))
                      ) : (
                        <p>-</p>
                      )}
                    </AccordionContent>
                  </AccordionItem>
                </Accordion>
              </Card>
            ))}
          </div>
        </div>

        {/* Filter panel */}
        <div
          className={`transition-all duration-500 ease-in-out ${
            viewMode || !openFilter
              ? "opacity-0 w-0 overflow-hidden pointer-events-none"
              : "opacity-100 w-[320px]"
          } shrink-0 self-start sticky top-0 h-[calc(80vh-200px)] overflow-hidden border-l pl-2`}
        >
          <FilteringComponent
            products={products}
            onFilter={(filtered) => setFilteredProducts(filtered)}
          />
        </div>
      </div>

      <DialogFooter className="mt-4 flex flex-col gap-3">
        <div className="w-full">
          <SPFTimer
            isActive={timerActive}
            startTime={spfCreationStartTime}
            label="Edit SPF Timer"
            onStart={(v) => setSpfCreationStartTime(v)}
            onStop={(v) => setSpfCreationEndTime(v)}
            onTick={() => {}}
          />
        </div>
        <div className="w-full flex justify-between items-center gap-2">
          <Button
            type="button"
            variant="secondary"
            className="rounded-none p-6"
            onClick={handleSaveDraft}
            disabled={isSavingDraft || itemDescriptions.length === 0}
          >
            <Save size={18} className="mr-2" />
            {isSavingDraft ? "Saving..." : hasDraft ? "Update Draft" : "Save Draft"}
          </Button>
          <div className="flex gap-2">
            <Button
              variant="outline"
              className="rounded-none p-6"
              onClick={() => {
                setEditMode(false);
                setViewMode(false);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="outline"
              className="rounded-none p-6"
              onClick={() => setViewMode((prev) => !prev)}
            >
              {viewMode ? "Back" : "Preview"}
            </Button>
          {viewMode && (
            <Button
              type="button"
              className="rounded-none p-6 bg-orange-600 hover:bg-orange-700"
              disabled={
                isSubmitting ||
                itemDescriptions.length === 0 ||
                itemDescriptions.some(
                  (_, i) => !productOffers[i] || productOffers[i].length === 0,
                ) ||
                Object.values(productOffers).flat().some(
                  (p: any) => !p.__priceValidity?.trim() || !p.__tdsBrand?.trim() ||
                    !p.__tdsPdfUrl?.trim() ||
                    (p.countries?.length > 1 && !p.__selectedBranch?.trim())
                )
              }
              onClick={handleSubmitEdit}
            >
              {isSubmitting ? "Saving..." : "Save Changes"}
            </Button>
          )}
          </div>
        </div>
      </DialogFooter>
    </div>
  );
};

  /* ════════════════════════════════════════════════════════════ */
  /* VIEW MODE — MOBILE                                          */
  /* ════════════════════════════════════════════════════════════ */
  const renderViewMobile = () => (
    <div className="space-y-4 pb-4">
      {itemDescriptions.map((desc: string, rowIndex: number) => {
        const prodImages = rowImages[rowIndex] ?? [];
        const prodQtys = rowQtys[rowIndex] ?? [];
        const prodUnitCosts = rowUnitCosts[rowIndex] ?? [];
        const prodPcsPerCartons = rowPcsPerCartons[rowIndex] ?? [];
        const prodPackaging = rowPackaging[rowIndex] ?? [];
        const prodWarranties = rowWarranties[rowIndex] ?? [];
        const prodFactories = rowFactories[rowIndex] ?? [];
        const prodPorts = rowPorts[rowIndex] ?? [];
        const prodSubtotals = rowSubtotals[rowIndex] ?? [];
        const prodBrands = rowSupplierBrands[rowIndex] ?? [];
        const prodSpecs = rowSpecs[rowIndex] ?? [];
        const prodCompanyNames = rowCompanyNames[rowIndex] ?? [];
        const prodContactNames = rowContactNames[rowIndex] ?? [];
        const prodContactNumbers = rowContactNumbers[rowIndex] ?? [];
        const prodLeadTimes = rowLeadTimes[rowIndex] ?? [];
        const prodSellingCosts = rowSellingCosts[rowIndex] ?? [];
        const prodFinalUnitCosts = rowFinalUnitCosts[rowIndex] ?? [];
        const prodFinalSubtotals = rowFinalSubtotals[rowIndex] ?? [];
        const prodItemCodes = rowItemCodes[rowIndex] ?? [];
        const prodSpfRemarksPD = rowSpfRemarksPD[rowIndex] ?? [];
        const prodSpfRemarksProcurement = rowSpfRemarksProcurement[rowIndex] ?? [];
        const prodProductNames = rowProductNames[rowIndex] ?? [];

        const hasProducts =
          prodImages.length > 0 &&
          !(prodImages.length === 1 && prodImages[0] === "");

        return (
          <div
            key={rowIndex}
            className="border border-gray-200 rounded-xl overflow-hidden shadow-sm bg-white"
          >
            <div className="bg-gray-50 border-b px-3 py-2 flex items-center gap-3">
              <span className="text-xs font-bold text-gray-500 shrink-0">
                {spfNumber}-{String(rowIndex + 1).padStart(3, "0")}
              </span>
              {itemImages[rowIndex] ? (
                <img
                  src={itemImages[rowIndex]}
                  className="w-10 h-10 object-contain rounded shrink-0 cursor-pointer hover:opacity-80 transition-opacity"
                  alt=""
                  onClick={() => openImagePreview(itemImages[rowIndex])}
                />
              ) : null}
              <p className="text-xs font-medium text-gray-800 line-clamp-2 flex-1">
                {desc.replace(/\|/g, " · ")}
              </p>
            </div>

            {!hasProducts ? (
              <p className="text-xs text-muted-foreground">No products added</p>
            ) : (
              <div className="divide-y">
                {prodImages.map((img: string, i: number) => {
                  const groups = prodSpecs[i] ?? [];
                  const optItemCode =
                    prodItemCodes[i] && prodItemCodes[i] !== "-"
                      ? prodItemCodes[i]
                      : null;
                  return (
                    <div key={i} className="px-3 py-3 space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="inline-flex items-center text-[10px] font-semibold px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200">
                          Option {i + 1}
                          {prodBrands[i] && prodBrands[i] !== "-"
                            ? ` · ${prodBrands[i]}`
                            : ""}
                        </span>
                        {optItemCode && (
                          <span className="inline-flex items-center text-[10px] font-mono px-2 py-0.5 rounded-full bg-gray-100 text-gray-600 border border-gray-200">
                            {optItemCode}
                          </span>
                        )}
                      </div>
                      <div className="flex gap-3 items-start">
                        {img && img !== "-" ? (
                          <img
                            src={img}
                            className="w-16 h-16 object-contain rounded border shrink-0 cursor-pointer hover:opacity-80 transition-opacity"
                            alt=""
                            onClick={() => openImagePreview(img)}
                          />
                        ) : (
                          <div className="w-16 h-16 bg-gray-100 rounded border shrink-0 flex items-center justify-center text-[10px] text-gray-400">
                            No img
                          </div>
                        )}
                        <div className="flex-1 min-w-0 space-y-1.5">
                          <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
                            <div>
                              <span className="text-gray-400 block">Product Name</span>
                              <span className="font-medium">
                                {prodProductNames[i] || "-"}
                              </span>
                            </div>
                            <div>
                              <span className="text-gray-400 block">Qty</span>
                              <span className="font-medium">
                                {prodQtys[i] || "-"}
                              </span>
                            </div>
                            <div>
                              <span className="text-gray-400 block">
                                Unit Cost
                              </span>
                              <span className="font-medium">
                                {prodUnitCosts[i] || "-"}
                              </span>
                            </div>
                            {(() => {
                              const commercialTypeRaw = (rowCommercialTypes[rowIndex] ?? [])[i];
                              const productName = prodProductNames[i];
                              const { qtyCtn, commercialType, packaging } = formatCommercialDetailsForView(
                                commercialTypeRaw,
                                prodPackaging[i],
                                prodPcsPerCartons[i],
                                productName,
                              );
                              return (
                                <>
                                  <div>
                                    <span className="text-gray-400 block">
                                      Qty/Per Carton
                                    </span>
                                    <span className="font-medium">
                                      {qtyCtn}
                                    </span>
                                  </div>
                                  <div>
                                    <span className="text-gray-400 block">
                                      Commercial Type
                                    </span>
                                    <span className="font-medium">
                                      {commercialType}
                                    </span>
                                  </div>
                                  <div>
                                    <span className="text-gray-400 block">
                                      Packaging
                                    </span>
                                    <span className="font-medium">
                                      {packaging}
                                    </span>
                                  </div>
                                  <div>
                                    <span className="text-gray-400 block">
                                      Subtotal
                                    </span>
                                    <span className="font-semibold text-gray-900">
                                      $
                                      {Number(prodSubtotals[i] || 0).toLocaleString()}
                                    </span>
                                  </div>
                                </>
                              );
                            })()}
                            <div>
                              <span className="text-gray-400 block">
                                Price Validity
                              </span>
                              <span className="font-medium">
                                {(() => {
                                  const pv = (rowPriceValidities[rowIndex] ?? [])[i];
                                  if (!pv || pv === "-") return "-";
                                  try { return new Date(pv).toLocaleString("en-US", { timeZone: "Asia/Manila", year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); } catch { return pv; }
                                })()}
                              </span>
                            </div>
                          </div>
                          {(() => {
                            const tdsUrl = (rowTdsUrls?.[rowIndex] ?? [])[i];
                            if (!tdsUrl || tdsUrl === "-" || tdsUrl === "") return null;
                            return (
                              <div>
                                <span className="text-gray-400 block">TDS</span>
                                <a
                                  href={tdsUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-xs text-blue-600 underline font-medium"
                                >
                                  View TDS
                                </a>
                              </div>
                            );
                          })()}
                          {prodFactories[i] && prodFactories[i] !== "-" && (
                            <p className="text-[10px] text-gray-500 truncate">
                              <span className="text-gray-400">Factory: </span>
                              {prodFactories[i]}
                            </p>
                          )}
                          {prodWarranties[i] && prodWarranties[i] !== "-" && (
                            <p className="text-[10px] text-gray-500 truncate">
                              <span className="text-gray-400">Warranty: </span>
                              {prodWarranties[i]}
                            </p>
                          )}
                          {prodPorts[i] && prodPorts[i] !== "-" && (
                            <p className="text-[10px] text-gray-500 truncate">
                              <span className="text-gray-400">Port: </span>
                              {prodPorts[i]}
                            </p>
                          )}
                          <MobileSpecsBlock groups={groups} />
                          <p className="text-[10px] text-gray-500 truncate">
                            <span className="text-gray-400">PD Remarks: </span>
                            {prodSpfRemarksPD[i] && prodSpfRemarksPD[i] !== "-" ? prodSpfRemarksPD[i] : "-"}
                          </p>
                          {showProcurementRemarks && (
                            <p className="text-[10px] text-gray-500 truncate">
                              <span className="text-gray-400">Procurement Remarks: </span>
                              {prodSpfRemarksProcurement[i] && prodSpfRemarksProcurement[i] !== "-" ? prodSpfRemarksProcurement[i] : "-"}
                            </p>
                          )}
                        </div>
                      </div>

                      {isApproved && (
                        <div className="mt-2 rounded-lg bg-green-50 border border-green-200 px-3 py-2 space-y-1">
                          <p className="text-[10px] font-bold uppercase text-green-700 mb-1">
                            Procurement Details
                          </p>
                          <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
                            <div>
                              <span className="text-gray-400 block">
                                Company
                              </span>
                              <span className="font-medium">
                                {prodCompanyNames[i] || "-"}
                              </span>
                            </div>
                            <div>
                              <span className="text-gray-400 block">
                                Contact
                              </span>
                              <span className="font-medium">
                                {prodContactNames[i] || "-"}
                              </span>
                            </div>
                            <div>
                              <span className="text-gray-400 block">
                                Contact No.
                              </span>
                              <span className="font-medium">
                                {prodContactNumbers[i] || "-"}
                              </span>
                            </div>
                            <div className="col-span-2">
                              <span className="text-gray-400 block">
                                Lead Time
                              </span>
                              <span className="font-medium">
                                {prodLeadTimes[i] && prodLeadTimes[i] !== "-"
                                  ? prodLeadTimes[i]
                                  : "-"}
                              </span>
                            </div>
                            <div>
                              <span className="text-gray-400 block">
                                Selling Cost
                              </span>
                              <span className="font-semibold text-green-700">
                                {prodSellingCosts[i] &&
                                prodSellingCosts[i] !== "-"
                                  ? `$${Number(prodSellingCosts[i]).toLocaleString()}`
                                  : "-"}
                              </span>
                            </div>
                            <div>
                              <span className="text-gray-400 block">
                                Final Unit Cost
                              </span>
                              <span className="font-semibold text-green-700">
                                {prodFinalUnitCosts[i] &&
                                prodFinalUnitCosts[i] !== "-"
                                  ? `$${Number(prodFinalUnitCosts[i]).toLocaleString()}`
                                  : "-"}
                              </span>
                            </div>
                            <div>
                              <span className="text-gray-400 block">
                                Final Subtotal
                              </span>
                              <span className="font-semibold text-green-700">
                                {prodFinalSubtotals[i] &&
                                prodFinalSubtotals[i] !== "-"
                                  ? `$${Number(prodFinalSubtotals[i]).toLocaleString()}`
                                  : "-"}
                              </span>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );

  /* ════════════════════════════════════════════════════════════ */
  /* VIEW MODE — DESKTOP TABLE                                   */
  /* ════════════════════════════════════════════════════════════ */
  const renderViewDesktop = () => 
    (
    <Card className="p-4 overflow-x-auto">
      <table className="w-full table-auto border text-sm">
        <thead>
          <tr className="bg-gray-100">
            <th className="border px-3 py-2 text-center whitespace-nowrap">
              #
            </th>
            <th className="border px-3 py-2 text-center whitespace-nowrap w-40">
              Image
            </th>
            <th className="border px-3 py-2 text-center whitespace-nowrap w-28">
              Item Qty
            </th>
            <th className="border px-3 py-2 text-center whitespace-nowrap">
              Item Description
            </th>
            <th className="border px-3 py-2 text-center">Product Offer</th>
          </tr>
        </thead>
        <tbody>
          {itemDescriptions.map((desc, rowIndex) => {
            const prodImages = rowImages[rowIndex] ?? [];
            const prodQtys = rowQtys[rowIndex] ?? [];
            const prodUnitCosts = rowUnitCosts[rowIndex] ?? [];
            const prodPcsPerCartons = rowPcsPerCartons[rowIndex] ?? [];
            const prodPackaging = rowPackaging[rowIndex] ?? [];
            const prodWarranties = rowWarranties[rowIndex] ?? [];
            const prodFactories = rowFactories[rowIndex] ?? [];
            const prodPorts = rowPorts[rowIndex] ?? [];
            const prodSubtotals = rowSubtotals[rowIndex] ?? [];
            const prodBrands = rowSupplierBrands[rowIndex] ?? [];
            const prodBranches = rowBranches[rowIndex] ?? [];
            const prodSpecs = rowSpecs[rowIndex] ?? [];
            const prodCompanyNames = rowCompanyNames[rowIndex] ?? [];
            const prodContactNames = rowContactNames[rowIndex] ?? [];
            const prodContactNumbers = rowContactNumbers[rowIndex] ?? [];
            const prodLeadTimes = rowLeadTimes[rowIndex] ?? [];
            const prodSellingCosts = rowSellingCosts[rowIndex] ?? [];
            const prodFinalUnitCosts = rowFinalUnitCosts[rowIndex] ?? [];
            const prodFinalSubtotals = rowFinalSubtotals[rowIndex] ?? [];
            const prodItemCodes = rowItemCodes[rowIndex] ?? [];
            const prodSpfRemarksPD = rowSpfRemarksPD[rowIndex] ?? [];
            const prodSpfRemarksProcurement = rowSpfRemarksProcurement[rowIndex] ?? [];
            const prodProductNames = rowProductNames[rowIndex] ?? [];

            const hasProducts =
              prodImages.length > 0 &&
              !(prodImages.length === 1 && prodImages[0] === "");

            return (
              <tr key={rowIndex} className="align-top">
                <td className="border px-3 py-2 text-center align-top pt-3 whitespace-nowrap font-medium">
                  {spfNumber}-{String(rowIndex + 1).padStart(3, "0")}
                </td>
                <td className="border px-3 py-2 text-center align-top pt-3">
                  {itemImages[rowIndex] ? (
                    <img
                      src={itemImages[rowIndex]}
                      className="w-36 h-36 object-contain mx-auto cursor-pointer hover:opacity-80 transition-opacity"
                      alt=""
                      onClick={() => openImagePreview(itemImages[rowIndex])}
                    />
                  ) : (
                    <span className="text-muted-foreground text-xs">-</span>
                  )}
                </td>
                <td className="border px-3 py-2 text-center align-top pt-3 text-sm">
                  {(() => {
                    const qtys = (requestData?.item_qty || "").split(",").map((q: string) => q.trim());
                    return qtys[rowIndex] || "-";
                  })()}
                </td>
                <td className="border px-3 py-2 whitespace-pre-wrap align-top pt-3 text-sm leading-relaxed">
                  {desc.replace(/\|/g, "\n")}
                </td>
                <td className="border px-2 py-2 align-top">
                  {!hasProducts ? (
                    <span className="text-xs text-muted-foreground">
                      No products added
                    </span>
                  ) : (
                    <div className="space-y-3">
                      {prodImages.map((img: string, i: number) => {
                        const groups = prodSpecs[i] ?? [];
                        const optItemCode =
                          prodItemCodes[i] && prodItemCodes[i] !== "-"
                            ? prodItemCodes[i]
                            : null;
                        return (
                          <div key={i}>
                            <div className="mb-1 flex flex-wrap items-center gap-2">
                              <span className="inline-flex items-center text-[11px] font-semibold px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200">
                                Option {i + 1}
                                {prodBrands[i] && ` · ${prodBrands[i]}`}
                              </span>
                              {optItemCode && (
                                <span className="inline-flex items-center text-[11px] font-mono px-2 py-0.5 rounded-full bg-gray-100 text-gray-600 border border-gray-200">
                                  {optItemCode}
                                </span>
                              )}
                            </div>
                            <div className="border rounded overflow-hidden">
                              <table className="w-full border text-xs">
                                <thead>
                                  <tr>
                                    <th colSpan={isApproved ? (showProcurementRemarks ? 25 : 24) : (showProcurementRemarks ? 18 : 17)} className="border px-2 py-1 text-center text-xs font-bold bg-orange-100 text-orange-700">
                                      Product Offer
                                    </th>
                                  </tr>
                                  <tr className="bg-gray-50">
                                    <th className="border px-2 py-1 text-center whitespace-nowrap">
                                      Supplier Brand
                                    </th>
                                    <th className="border px-2 py-1 text-center whitespace-nowrap">
                                      Product Name
                                    </th>
                                    <th className="border px-2 py-1 text-center whitespace-nowrap">
                                      Branch
                                    </th>
                                    <th className="border px-2 py-1 text-center whitespace-nowrap w-28">
                                      Image
                                    </th>
                                    <th className="border px-2 py-1 text-center whitespace-nowrap">
                                      Qty
                                    </th>
                                    <th className="border px-2 py-1 text-center whitespace-nowrap">
                                      Price Validity
                                    </th>
                                    <th className="border px-2 py-1 text-center whitespace-nowrap">
                                      TDS
                                    </th>
                                    <th className="border px-2 py-1 text-center min-w-50">
                                      Technical Specs
                                    </th>
                                    <th className="border px-2 py-1 text-center whitespace-nowrap">
                                      Unit Cost
                                    </th>
                                    <th className="border px-2 py-1 text-center whitespace-nowrap">
                                      Qty/Per Carton
                                    </th>
                                    <th className="border px-2 py-1 text-center whitespace-nowrap">
                                      Commercial Type
                                    </th>
                                    <th className="border px-2 py-1 text-center whitespace-nowrap">
                                      Packaging
                                    </th>
                                    <th className="border px-2 py-1 text-center whitespace-nowrap">
                                      Warranty
                                    </th>
                                    <th className="border px-2 py-1 text-center whitespace-nowrap">
                                      Factory
                                    </th>
                                    <th className="border px-2 py-1 text-center whitespace-nowrap">
                                      Port
                                    </th>
                                    <th className="border px-2 py-1 text-center whitespace-nowrap">
                                      Subtotal
                                    </th>
                                    {isApproved && (
                                      <>
                                        <th className="border px-2 py-1 text-center whitespace-nowrap">
                                          Company
                                        </th>
                                        <th className="border px-2 py-1 text-center whitespace-nowrap">
                                          Contact Name
                                        </th>
                                        <th className="border px-2 py-1 text-center whitespace-nowrap">
                                          Contact No.
                                        </th>
                                        <th className="border px-2 py-1 text-center whitespace-nowrap bg-green-50 text-green-700">
                                          Lead Time
                                        </th>
                                        <th className="border px-2 py-1 text-center whitespace-nowrap bg-green-50 text-green-700">
                                          Selling Cost
                                        </th>
                                        <th className="border px-2 py-1 text-center whitespace-nowrap bg-green-50 text-green-700">
                                          Final Unit Cost
                                        </th>
                                        <th className="border px-2 py-1 text-center whitespace-nowrap bg-green-50 text-green-700">
                                          Final Subtotal
                                        </th>
                                      </>
                                    )}
                                    {showProcurementRemarks && (
                                      <th className="border px-2 py-1 text-center whitespace-nowrap bg-blue-50 text-blue-700">
                                        Procurement Remarks
                                      </th>
                                    )}
                                    <th className="border px-2 py-1 text-center whitespace-nowrap bg-blue-50 text-blue-700">
                                      PD Remarks
                                    </th>
                                  </tr>
                                </thead>
                                <tbody>
                                  <tr className="align-top bg-orange-50">
                                    <td className="border px-2 py-2 text-center align-middle font-medium">
                                      {prodBrands[i] || "-"}
                                    </td>
                                    <td className="border px-2 py-2 text-center align-middle font-medium">
                                      {prodProductNames[i] || "-"}
                                    </td>
                                    <td className="border px-2 py-2 text-center align-middle font-medium">
                                      {prodBranches[i] || "-"}
                                    </td>
                                    <td className="border px-2 py-2 text-center align-middle">
                                      {img && img !== "-" ? (
                                        <img
                                          src={img}
                                          className="w-24 h-24 object-contain mx-auto cursor-pointer hover:opacity-80 transition-opacity"
                                          alt=""
                                          onClick={() => openImagePreview(img)}
                                        />
                                      ) : (
                                        <span className="text-muted-foreground">
                                          -
                                        </span>
                                      )}
                                    </td>
                                    <td className="border px-2 py-2 text-center align-middle">
                                      {prodQtys[i] || "-"}
                                    </td>
                                    <td className="border px-2 py-2 text-center align-middle whitespace-nowrap">
                                      {(() => {
                                        const pv = (rowPriceValidities[rowIndex] ?? [])[i];
                                        if (!pv || pv === "-") return "-";
                                        try { return new Date(pv).toLocaleString("en-US", { timeZone: "Asia/Manila", year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); } catch { return pv; }
                                      })()}
                                    </td>
                                    <td className="border px-2 py-2 text-center align-middle whitespace-nowrap">
                                      {(() => {
                                        const tdsUrl = (rowTdsUrls?.[rowIndex] ?? [])[i];
                                        if (!tdsUrl || tdsUrl === "-" || tdsUrl === "") return "-";
                                        return (
                                          <a
                                            href={tdsUrl}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="text-[11px] text-blue-600 underline font-medium"
                                          >
                                            View TDS
                                          </a>
                                        );
                                      })()}
                                    </td>
                                    <td className="border px-2 py-2 align-top">
                                      {groups.length === 0 ? (
                                        <span className="text-muted-foreground">
                                          -
                                        </span>
                                      ) : (
                                        <div className="space-y-2">
                                          {groups.map((group, gi) => (
                                            <div key={gi}>
                                              {group.title && (
                                                <p className="font-bold text-[11px] uppercase tracking-wide text-gray-800 mb-0.5">
                                                  {group.title}
                                                </p>
                                              )}
                                              <div className="text-xs">
                                                {group.specs.map(
                                                  (spec, si: number) => (
                                                    <div key={si}>
                                                      {spec}
                                                    </div>
                                                  ),
                                                )}
                                              </div>
                                            </div>
                                          ))}
                                        </div>
                                      )}
                                    </td>
                                    <td className="border px-2 py-2 text-center align-middle">
                                      {prodUnitCosts[i] || "-"}
                                    </td>
                                    {(() => {
                                      const commercialTypeRaw = (rowCommercialTypes[rowIndex] ?? [])[i];
                                      const productName = prodProductNames[i];
                                      const { qtyCtn, commercialType, packaging } = formatCommercialDetailsForView(
                                        commercialTypeRaw,
                                        prodPackaging[i],
                                        prodPcsPerCartons[i],
                                        productName,
                                      );
                                      return (
                                        <>
                                          <td className="border px-2 py-2 text-center align-middle">
                                            {qtyCtn}
                                          </td>
                                          <td className="border px-2 py-2 text-center align-middle">
                                            {commercialType}
                                          </td>
                                          <td className="border px-2 py-2 text-center align-middle">
                                            {packaging}
                                          </td>
                                        </>
                                      );
                                    })()}
                                    <td className="border px-2 py-2 text-center align-middle">
                                      {prodWarranties[i] || "-"}
                                    </td>
                                    <td className="border px-2 py-2 text-center align-middle">
                                      {prodFactories[i] || "-"}
                                    </td>
                                    <td className="border px-2 py-2 text-center align-middle">
                                      {prodPorts[i] || "-"}
                                    </td>
                                    <td className="border px-2 py-2 text-center align-middle font-semibold">
                                      $
                                      {Number(
                                        prodSubtotals[i] || 0,
                                      ).toLocaleString()}
                                    </td>
                                    {isApproved && (
                                      <>
                                        <td className="border px-2 py-2 text-center align-middle">
                                          {prodCompanyNames[i] || "-"}
                                        </td>
                                        <td className="border px-2 py-2 text-center align-middle">
                                          {prodContactNames[i] || "-"}
                                        </td>
                                        <td className="border px-2 py-2 text-center align-middle">
                                          {prodContactNumbers[i] || "-"}
                                        </td>
                                        <td className="border px-2 py-2 text-center align-middle bg-green-50">
                                          {prodLeadTimes[i] &&
                                          prodLeadTimes[i] !== "-"
                                            ? prodLeadTimes[i]
                                            : "-"}
                                        </td>
                                        <td className="border px-2 py-2 text-center align-middle bg-green-50 text-green-700 font-semibold">
                                          {prodSellingCosts[i] &&
                                          prodSellingCosts[i] !== "-"
                                            ? `$${Number(prodSellingCosts[i]).toLocaleString()}`
                                            : "-"}
                                        </td>
                                        <td className="border px-2 py-2 text-center align-middle bg-green-50 text-green-700 font-semibold">
                                          {prodFinalUnitCosts[i] &&
                                          prodFinalUnitCosts[i] !== "-"
                                            ? `$${Number(prodFinalUnitCosts[i]).toLocaleString()}`
                                            : "-"}
                                        </td>
                                        <td className="border px-2 py-2 text-center align-middle bg-green-50 text-green-700 font-semibold">
                                          {prodFinalSubtotals[i] &&
                                          prodFinalSubtotals[i] !== "-"
                                            ? `$${Number(prodFinalSubtotals[i]).toLocaleString()}`
                                            : "-"}
                                        </td>
                                      </>
                                    )}
                                    {showProcurementRemarks && (
                                      <td className="border px-2 py-2 text-center align-middle bg-blue-50 whitespace-pre-wrap">
                                        {prodSpfRemarksProcurement[i] && prodSpfRemarksProcurement[i] !== "-" ? prodSpfRemarksProcurement[i] : "-"}
                                      </td>
                                    )}
                                    <td className="border px-2 py-2 text-center align-middle bg-blue-50 whitespace-pre-wrap">
                                      {prodSpfRemarksPD[i] && prodSpfRemarksPD[i] !== "-" ? prodSpfRemarksPD[i] : "-"}
                                    </td>
                                  </tr>
                                </tbody>
                              </table>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Card>
  );

  /* ── Check if quantity is valid (not below original) ── */
  const isQtyValid = (rowIndex: number, optionIndex: number, qty: number): boolean => {
    const key = `${rowIndex}_${optionIndex}`;
    const originalQty = originalQuantities[key] ?? 1;
    return qty >= originalQty;
  };

  /* ── Get minimum quantity for an option ── */
  const getMinQty = (rowIndex: number, optionIndex: number): number => {
    const key = `${rowIndex}_${optionIndex}`;
    return originalQuantities[key] ?? 1;
  };

  /* ── Get minimum unit cost for an option (for price update validation) ── */
  const getMinUnitCost = (rowIndex: number, optionIndex: number): number => {
    const key = `${rowIndex}_${optionIndex}`;
    return originalUnitCosts[key] ?? 0;
  };

  /* ── Open image preview dialog ── */
  const openImagePreview = (url: string | null | undefined) => {
    if (!url || url === "-") return;
    setPreviewImageUrl(url);
    setImagePreviewOpen(true);
  };

  /* ── Open specs revision modal for a product ── */
  const openSpecsRevision = (rowIndex: number, optionIndex: number) => {
    const product = productOffers[rowIndex]?.[optionIndex];
    if (!product) return;
    
    // Use original specs if available, otherwise current specs
    const specsToUse = product.__originalTechnicalSpecifications || product.technicalSpecifications;
    const productWithOriginalSpecs = {
      ...product,
      technicalSpecifications: specsToUse,
    };
    
    // Create a frozen copy of the product specs for revision
    const frozen = freezeSpecs(productWithOriginalSpecs);
    if (hasMultipleSpecValues(frozen)) {
      setPendingPipeProduct(frozen);
      setPendingPipeRowIndex(rowIndex);
      setPendingPipeOptionIndex(optionIndex);
      setShowPipeModal(true);
    } else {
      toast.info("No multiple specification values detected for this product.");
    }
  };

  /* ── Handle specs revision confirmation ── */
  const [pendingPipeOptionIndex, setPendingPipeOptionIndex] = useState<number | null>(null);
  
  const handleSpecsRevisionConfirm = (filteredProduct: any) => {
    if (pendingPipeRowIndex === null || pendingPipeOptionIndex === null) return;
    
    // Update the product with revised specs
    setProductOffers((prev) => {
      const copy = { ...prev };
      const row = [...(copy[pendingPipeRowIndex] || [])];
      row[pendingPipeOptionIndex] = { 
        ...row[pendingPipeOptionIndex], 
        technicalSpecifications: filteredProduct.technicalSpecifications,
        __specsRevised: true
      };
      copy[pendingPipeRowIndex] = row;
      return copy;
    });
    
    toast.success("Product specifications updated!");
    setPendingPipeProduct(null);
    setPendingPipeRowIndex(null);
    setPendingPipeOptionIndex(null);
    setShowPipeModal(false);
  };

  /* ════════════════════════════════════════════════════════════ */
  /* DIALOG WRAPPER                                              */
  /* ════════════════════════════════════════════════════════════ */
  return (
    <>
      {/* ── Revision Type Selector ── */}
      <RevisionTypeSelector
        open={showRevisionSelector}
        onOpenChange={setShowRevisionSelector}
        onSelect={handleRevisionTypeSelect}
        spfNumber={spfNumber}
      />
      {/* ── Trigger button + status badge ── */}
      <div className="flex items-center gap-2 flex-nowrap whitespace-nowrap">
        <Button
          variant="outline"
          className="rounded-none px-4 py-2 h-9 shrink-0"
          onClick={() => {
            // Check if this is a revise action from Special Instructions
            const currentBtn = document.activeElement as HTMLElement;
            const isReviseFromSpecial = currentBtn?.dataset?.reviseFromSpecial === "true";
            if (isReviseFromSpecial) {
              setReviseFromSpecial(true);
            }
            onOpen?.();
            setOpen(true);
          }}
          data-spf-fetch={triggerDataAttr}
        >
          View
        </Button>

        {data?.status && (
          <span
            className={`text-xs px-2 py-1 rounded uppercase shrink-0 ${
              isCancelled
                ? "bg-red-100 text-red-700"
                : isApproved
                  ? "bg-green-100 text-green-700"
                  : isForRevision
                    ? "bg-orange-100 text-orange-700"
                    : "bg-yellow-100 text-yellow-700"
            }`}
          >
            {getStatusLabel(data.status)}
          </span>
        )}
      </div>

      {/* ── Main view dialog ── */}
      <Dialog
        open={open && !editMode}
        onOpenChange={(o) => {
          if (!o) {
            setOpen(false);
            setEditMode(false);
          } else setOpen(true);
        }}
      >
        <DialogContent
          className={
            isMobile
              ? "w-full max-w-full h-dvh rounded-none p-0 flex flex-col overflow-hidden"
              : "sm:max-w-8xl max-h-[90vh] flex flex-col overflow-hidden rounded-none"
          }
        >
          <DialogHeader
            className={
              isMobile ? "px-4 pt-4 pb-3 border-b shrink-0" : "space-y-2 shrink-0"
            }
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <ForPoolingButton show={showPoolingButton} spfNumber={spfNumber} />
                <DialogTitle className="flex items-center gap-2">
                  SPF Request View
                  {latestVersionLabel && (
                    <span className="text-[11px] px-2 py-0.5 rounded bg-indigo-100 text-indigo-700 border border-indigo-200 font-mono">
                      {latestVersionLabel}
                    </span>
                  )}
                </DialogTitle>
              </div>
              <SPFRequestFetchVersionHistory
                spfNumber={spfNumber}
                isMobile={isMobile}
              />
            </div>

            <div className="flex flex-wrap items-center gap-3 text-sm mt-1">
              {data?.status && (
                <div className="flex items-center gap-2">
                  <span className="font-medium text-xs">Status:</span>
                  <span
                    className={`px-2 py-0.5 text-[10px] rounded uppercase font-semibold ${
                      isCancelled
                        ? "bg-red-100 text-red-700"
                        : isApproved
                          ? "bg-green-100 text-green-700"
                          : isForRevision
                            ? "bg-orange-100 text-orange-700"
                            : "bg-yellow-100 text-yellow-700"
                    }`}
                  >
                    {getStatusLabel(data.status)}
                  </span>
                </div>
              )}

              {data?.item_added_author && (
                <div className="flex items-center gap-2">
                  <span className="font-medium text-xs">Author:</span>
                  <span className="text-xs text-muted-foreground">
                    {getResolvedName(data.item_added_author)}
                  </span>
                </div>
              )}

              {/* Hidden for now */}
              {/* {canEditOffer && (
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5 text-xs border-orange-300 text-orange-700 hover:bg-orange-50"
                  onClick={() => {
                    // Check if revision_type is already set in data
                    const existingRevisionType = data?.revision_type;
                    if (existingRevisionType) {
                      // Map database value to RevisionType
                      const typeMap: Record<string, RevisionType> = {
                        "Price Update": "price",
                        "Change Item Specs & Qty": "specs",
                        "Both": "both",
                      };
                      const mappedType = typeMap[existingRevisionType];
                      if (mappedType) {
                        // Skip selector and go directly to edit mode
                        setRevisionType(mappedType);
                        setOpen(false);
                        setTimeout(() => {
                          enterEditMode(mappedType);
                          setEditMode(true);
                          setOpen(true);
                        }, 50);
                        return;
                      }
                    }
                    // Show selector if no revision_type set
                    setShowRevisionSelector(true);
                  }}
                >
                  <Pencil size={12} />
                  Edit (Revise)
                </Button>
              )} */}
            </div>

            {/* Speech balloon for revision remarks */}
            {isForRevision && data?.revision_remarks && (
              <div className="relative mt-2 max-w-md">
                <div className="relative bg-orange-50 border-2 border-orange-300 rounded-2xl px-4 py-3 shadow-sm">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-[10px] font-bold uppercase tracking-wide text-orange-600 bg-orange-200 px-2 py-0.5 rounded">
                      {data.revision_type || "Revision"}
                    </span>
                  </div>
                  <p className="text-xs text-orange-800 font-medium leading-relaxed">
                    {data.revision_remarks}
                  </p>
                  {/* Speech balloon tail */}
                  <div className="absolute -top-2 left-6 w-4 h-4 bg-orange-50 border-t-2 border-l-2 border-orange-300 transform rotate-45"></div>
                </div>
              </div>
            )}
          </DialogHeader>

          <div
            className={
              isMobile ? "flex-1 overflow-y-auto px-3 pt-3 pb-4" : "flex-1 overflow-y-auto mt-2"
            }
          >
            {loading && (
              <p className="text-sm text-muted-foreground text-center py-8">
                Loading...
              </p>
            )}
            {!loading &&
              data &&
              (isMobile ? renderViewMobile() : renderViewDesktop())}
            {!loading && !data && (
              <p className="text-sm text-muted-foreground text-center py-8">
                No SPF creation found.
              </p>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Edit dialog (For Revision) ── */}
      <Dialog
        open={open && editMode}
        onOpenChange={(o) => {
          if (!o) {
            setOpen(false);
            setEditMode(false);
          } else setOpen(true);
        }}
      >
        <DialogContent
          className={
            isMobile
              ? "w-full max-w-full h-dvh rounded-none p-0 flex flex-col overflow-y-auto"
              : "sm:max-w-8xl max-h-[90vh] flex flex-col overflow-y-auto rounded-none"
          }
        >
          {isMobile ? renderEditMobile() : renderEditDesktop()}
        </DialogContent>
      </Dialog>

      {/* ── Desktop MultipleSpecsDetected — outside Dialog stack ── */}
      {!isMobile && (
        <MultipleSpecsDetected
          open={showPipeModal}
          onClose={handlePipeClose}
          product={pendingPipeProduct}
          onConfirm={pendingPipeOptionIndex !== null ? handleSpecsRevisionConfirm : handlePipeConfirm}
        />
      )}

      {/* ── Mobile MultipleSpecsDetected ── */}
      {isMobile && (
        <MultipleSpecsDetected
          open={showPipeModal}
          onClose={handlePipeClose}
          product={pendingPipeProduct}
          onConfirm={pendingPipeOptionIndex !== null ? handleSpecsRevisionConfirm : handlePipeConfirm}
        />
      )}

      {/* ── Add Product sub-dialog (edit mode) ── */}
      <Dialog open={openAddProduct && canAddProduct} onOpenChange={setOpenAddProduct}>
        <DialogContent
          className={
            isMobile
              ? "w-full max-w-full h-dvh rounded-none p-0 flex flex-col overflow-hidden"
              : "sm:max-w-8xl max-h-[90vh] overflow-y-auto rounded-none"
          }
        >
          <DialogHeader
            className={isMobile ? "px-4 pt-4 pb-2 border-b shrink-0" : ""}
          >
            <DialogTitle>Add Product</DialogTitle>
          </DialogHeader>
          <div className={isMobile ? "flex-1 overflow-y-auto p-4" : ""}>
            <AddProductComponent onClose={() => setOpenAddProduct(false)} />
          </div>
          <DialogFooter
            className={isMobile ? "px-4 py-3 border-t shrink-0" : ""}
          >
            <Button
              variant="outline"
              className={isMobile ? "w-full rounded-none" : "rounded-none"}
              onClick={() => setOpenAddProduct(false)}
            >
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 🔥 EDIT PRODUCT MODAL */}
      <Dialog open={openEditProduct && canEditProduct} onOpenChange={setOpenEditProduct}>
        <DialogContent className="sm:max-w-8xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit Product</DialogTitle>
          </DialogHeader>

          {selectedProduct?.id && (
            <EditProductComponent
              productId={selectedProduct.id}
              onClose={() => setOpenEditProduct(false)}
            />
          )}

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setOpenEditProduct(false)}
            >
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 🔥 ROW SELECTION DIALOG */}
      <Dialog open={showRowSelectModal} onOpenChange={setShowRowSelectModal}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Select Row to Add Product</DialogTitle>
          </DialogHeader>
          <div className="py-4">
            <p className="text-sm text-muted-foreground mb-4">
              Choose which item row to add the product to:
            </p>
            <div className="space-y-2 max-h-75 overflow-y-auto">
              {itemDescriptions.map((desc, index) => (
                <button
                  key={index}
                  type="button"
                  onClick={() => handleRowSelectConfirm(index)}
                  className="w-full flex items-center gap-3 p-3 border rounded-lg hover:bg-accent hover:border-primary transition-colors text-left"
                >
                  <span className="shrink-0 w-8 h-8 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-sm font-bold">
                    {index + 1}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">
                      {spfNumber}-{String(index + 1).padStart(3, "0")}
                    </p>
                    <p className="text-xs text-muted-foreground line-clamp-1">
                      {desc?.replace(/\|/g, " · ") || "No description"}
                    </p>
                  </div>
                  <Plus size={16} className="text-green-600 shrink-0" />
                </button>
              ))}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={handleRowSelectCancel}>
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Image Preview Dialog ── */}
      <Dialog open={imagePreviewOpen} onOpenChange={setImagePreviewOpen}>
        <DialogContent className="sm:max-w-3xl max-h-[90vh] rounded-none p-0 overflow-hidden">
          <DialogHeader className="px-4 py-3 border-b shrink-0">
            <DialogTitle className="text-sm">Image Preview</DialogTitle>
          </DialogHeader>
          <div className="flex items-center justify-center p-6 bg-gray-50 min-h-75">
            {previewImageUrl ? (
              <img
                src={previewImageUrl}
                className="max-w-full max-h-[70vh] object-contain"
                alt="Preview"
              />
            ) : (
              <span className="text-muted-foreground">No image</span>
            )}
          </div>
          <DialogFooter className="px-4 py-3 border-t shrink-0">
            <Button variant="outline" onClick={() => setImagePreviewOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* DUPLICATE CONFIRMATION DIALOG */}
      <AlertDialog open={!!duplicateTarget} onOpenChange={(open) => !open && setDuplicateTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Duplicate Product</AlertDialogTitle>
            <AlertDialogDescription>
              Do you want to duplicate &quot;{duplicateTarget?.name}&quot;?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={duplicating}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDuplicate} disabled={duplicating}>
              {duplicating ? "Duplicating..." : "Confirm"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Generate TDS Dialog ── */}
      <SPFGenerateTDSDialog
        open={tdsDialogOpen}
        onClose={() => {
          setTdsDialogOpen(false);
          setSelectedProductForTDS(null);
          setSelectedRowIndexForTDS(null);
          setSelectedOptionIndexForTDS(null);
        }}
        product={selectedProductForTDS}
        onTDSGenerated={(payload) => {
          if (selectedRowIndexForTDS === null || selectedOptionIndexForTDS === null) return;
          setProductOffers((prev) => {
            const copy = { ...prev };
            const row = [...(copy[selectedRowIndexForTDS] || [])];
            const product = row[selectedOptionIndexForTDS];
            if (!product) return prev;

            row[selectedOptionIndexForTDS] = {
              ...product,
              __tdsPdfUrl: payload.tdsUrl,
              __tdsBrand: payload.tdsBrand,
              __tdsProductName: payload.productName,
              dimensionalDrawing: payload.dimensionalDrawingUrl
                ? { url: payload.dimensionalDrawingUrl }
                : null,
              illuminanceDrawing: payload.illuminanceDrawingUrl
                ? { url: payload.illuminanceDrawingUrl }
                : null,
            };
            copy[selectedRowIndexForTDS] = row;
            return copy;
          });
        }}
      />
    </>
  );
}
