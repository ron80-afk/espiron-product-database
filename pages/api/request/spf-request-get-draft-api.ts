import type { NextApiRequest, NextApiResponse } from "next";
import { supabase } from "@/utils/supabase";

const ROW_SEP = "|ROW|";

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
    return Buffer.from(base64, "base64").toString("utf-8");
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
    if (
      parsed?.v !== 1 ||
      parsed?.type !== "LIGHT_MULTIPLE" ||
      !Array.isArray(parsed?.rows)
    ) {
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
  if (raw.startsWith("MULTI:")) return decodeMultiPackaging(raw);

  const lines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l);
  if (lines.length === 0) return null;

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
      const qtyLine = lines[i + 1] || "";
      dimensions = lines[i + 2] || "";
      unitCostStr = lines[i + 3] || "";
      const qtyMatch = qtyLine.match(/^Qty:\s*(\d+)/);
      qtyPerCarton = qtyMatch ? parseInt(qtyMatch[1], 10) : 0;
    } else {
      dimensions = lines[i + 1] || "";
      unitCostStr = lines[i + 2] || "";
      qtyPerCarton = 0;
    }

    const dimParts = dimensions.split("×").map((p) => p.trim());
    const length = dimParts[0] || "-";
    const width = dimParts[1] || "-";
    const height = dimParts[2] || "-";

    const costMatch = unitCostStr.match(/^([\d.]+)/);
    const unitCost = costMatch ? parseFloat(costMatch[1]) : 0;

    rows.push({ itemName, length, width, height, unitCost, qtyPerCarton });
  }

  if (rows.length === 0) return null;
  return { v: 1, type: "LIGHT_MULTIPLE", rows };
}

function parsePackagingDimensions(packagingStr: string | undefined): { length: string; width: string; height: string } {
  const raw = (packagingStr ?? "").trim();
  if (!raw || raw === "-") return { length: "-", width: "-", height: "-" };
  const parts = raw
    .split(/(?:\s*x\s*|\s*×\s*)/i)
    .map((p) => p.trim())
    .filter(Boolean);
  const length = parts[0] ?? "-";
  const width = parts[1] ?? "-";
  const height = parts[2] ?? "-";
  return { length, width, height };
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "GET") {
    return res.status(405).json({ message: "Method not allowed" });
  }

  try {
    const { spf_number } = req.query;

    if (!spf_number || typeof spf_number !== "string") {
      return res.status(400).json({ message: "Missing SPF number" });
    }

    /* ── Fetch draft ── */
    const { data: draft, error } = await supabase
      .from("spf_creation_draft")
      .select("*")
      .eq("spf_number", spf_number)
      .maybeSingle();

    if (error) {
      console.error("Draft fetch error:", error);
      return res.status(500).json({ message: "Failed to fetch draft", error });
    }

    if (!draft) {
      return res.status(404).json({ message: "No draft found", hasDraft: false });
    }

    /* ── Split a flat string into per-option strings ──
     * save-draft-api always joins with a single ROW_SEP ("|ROW|"),
     * both for options-within-a-row and rows-between-each-other.
     * There is no separate "old" format — a row with 0 offers just
     * produces an accidental "|ROW||ROW|" substring, which the old
     * detectFormat() heuristic misread as "old format" and used the
     * wrong delimiter, leaving the whole field un-split. Always
     * split on ROW_SEP. */
    const splitRows = (value: string | null): string[] => {
      if (!value) return [];
      return value.split(ROW_SEP);
    };

    /* ──────────────────────────────────────────────────────────
     * KEY FIX: Determine true row count and group options by row
     *
     * The save API writes one |ROW| entry PER PRODUCT OPTION.
     * Row 0 option A  → "SPF-001-A"
     * Row 0 option B  → "SPF-001-B"
     * Row 1 option    → "SPF-002"
     *
     * We must re-group those flat entries back into rows.
     * ────────────────────────────────────────────────────────── */
    const rawItemCodes = splitRows(draft.item_code);

    // Strip trailing -A / -B / -C / -AA etc. to get the base row code
    const getBaseCode = (code: string): string =>
      code.replace(/-[A-Z]+$/, "").trim();

    // Build ordered list of unique base codes (preserves row order)
    const orderedBaseCodes: string[] = [];
    const baseCodeSet = new Set<string>();
    for (const code of rawItemCodes) {
      const base = getBaseCode(code);
      if (!baseCodeSet.has(base)) {
        baseCodeSet.add(base);
        orderedBaseCodes.push(base);
      }
    }

    // rowCount = number of unique base codes = number of item rows
    const rowCount = orderedBaseCodes.length || splitRows(draft.product_offer_image).length || 1;

    // Map each flat index → which rowIndex it belongs to
    const flatIndexToRowIndex: number[] = rawItemCodes.map((code) => {
      const base = getBaseCode(code);
      return orderedBaseCodes.indexOf(base);
    });

    /* ── Helper to format datetime-local ── */
    const formatDateTimeLocal = (value: string | null): string => {
      if (!value || value === "-" || value === "") return "";
      if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return value;
      try {
        const parsed = new Date(value);
        if (!isNaN(parsed.getTime())) {
          const year = parsed.getFullYear();
          const month = String(parsed.getMonth() + 1).padStart(2, "0");
          const day = String(parsed.getDate()).padStart(2, "0");
          const hours = String(parsed.getHours()).padStart(2, "0");
          const minutes = String(parsed.getMinutes()).padStart(2, "0");
          return `${year}-${month}-${day}T${hours}:${minutes}`;
        }
      } catch {}
      return value;
    };

    /* ── Flat arrays (one entry per product option) ── */
    const flatImages          = splitRows(draft.product_offer_image);
    const flatQtys            = splitRows(draft.product_offer_qty);
    const flatUnitCosts       = splitRows(draft.product_offer_unit_cost);
    const flatPcsPerCartons   = splitRows(draft.product_offer_pcs_per_carton);
    const flatPackaging       = splitRows(draft.product_offer_packaging_details);
    const flatWarranties      = splitRows((draft as any).warranty ?? null);
    const flatFactories       = splitRows(draft.product_offer_factory_address);
    const flatPorts           = splitRows(draft.product_offer_port_of_discharge);
    const flatSubtotals       = splitRows(draft.product_offer_subtotal);
    const flatSupplierBrands  = splitRows(draft.supplier_brand);
    const flatCompanyNames    = splitRows(draft.company_name);
    const flatContactNames    = splitRows(draft.contact_name);
    const flatContactNumbers  = splitRows(draft.contact_number);
    const flatSellingCosts    = splitRows(draft.final_selling_cost);
    const flatLeadTimes       = splitRows(draft.proj_lead_time);
    const flatPriceValidities = splitRows(draft.price_validity);
    const flatDimDrawings     = splitRows(draft.dimensional_drawing);
    const flatIllumDrawings   = splitRows(draft.illuminance_drawing);
    const flatProductNames    = splitRows((draft as any).product_name ?? null);
    const flatTdsBrands       = splitRows((draft as any).tds_brand ?? null);
    const flatProductRefIDs   = splitRows(draft.product_reference_id);
    const flatBranches        = splitRows(draft.supplier_branch);
    const flatSpfRemarksPD    = splitRows(draft.spf_remarks_pd);
    const flatCommercialTypes = splitRows(draft.commercial_type);
    const flatTdsPdfUrls      = splitRows(draft.tds);
    const flatIsExisting      = splitRows(draft.is_existing);

    /* ── Parse technical specs (per flat index) ── */
    const parseSingleRowSpec = (raw: string): any[] => {
      if (!raw || raw === "-") return [];
      const groups = raw.split("@@");
      return groups.map((group) => {
        const [title, specsStr] = group.split("~~");
        const specs = specsStr
          ? specsStr.split(";;").map((spec) => {
              const colonIdx = spec.indexOf(":");
              if (colonIdx === -1) return { specId: spec.trim(), value: "" };
              return {
                specId: spec.slice(0, colonIdx).trim(),
                value: spec.slice(colonIdx + 1).trim(),
              };
            })
          : [];
        return { title: title?.trim() ?? "", specs };
      });
    };

    const flatSpecs     = splitRows(draft.product_offer_technical_specification).map(parseSingleRowSpec);
    const flatOrigSpecs = splitRows(draft.original_technical_specification).map(parseSingleRowSpec);

    /* ── Re-group flat options into rows ── */
    const productOffersByRow: Record<number, any[]> = {};
    for (let rowIdx = 0; rowIdx < rowCount; rowIdx++) {
      productOffersByRow[rowIdx] = [];
    }

    for (let flatIdx = 0; flatIdx < flatImages.length; flatIdx++) {
      const img = flatImages[flatIdx];
      if (!img || img === "-") continue;

      const rowIdx = flatIndexToRowIndex[flatIdx] ?? 0;
      const commercialTypeRaw = (flatCommercialTypes[flatIdx] || "BASIC").toUpperCase();
      const rawPackaging = flatPackaging[flatIdx] || "-";

      let packagingData = { length: "-", width: "-", height: "-" };
      let useArrayInput = false;
      let multiRows: LightMultipleRow[] = [];
      let totalUnitCost: number | undefined;

      // Normalize DB labels to internal types
      const isLightMultiple = commercialTypeRaw === "LIGHT (MULTIPLE)" || commercialTypeRaw === "LIGHT_MULTIPLE";
      const isLightSingle = commercialTypeRaw === "LIGHT (SINGLE)" || commercialTypeRaw === "LIGHT_SINGLE";
      const isLightType = commercialTypeRaw === "LIGHT" || isLightMultiple || isLightSingle;
      const isPoleType = commercialTypeRaw === "POLE";

      if (isLightMultiple || (isLightType && !isLightSingle)) {
        // Try to parse as Light Multiple first
        const decodedMulti = parseHumanReadableMultiPackaging(rawPackaging);
        if (decodedMulti?.rows?.length) {
          useArrayInput = true;
          multiRows = decodedMulti.rows.map((r) => ({
            itemName: r.itemName ?? "",
            unitCost: Number(r.unitCost ?? 0) || 0,
            length: (r.length ?? "-").toString(),
            width: (r.width ?? "-").toString(),
            height: (r.height ?? "-").toString(),
            qtyPerCarton: Number(r.qtyPerCarton ?? 0) || 0,
          }));
          totalUnitCost = multiRows.reduce(
            (sum: number, r: LightMultipleRow) => sum + (Number(r.unitCost) || 0),
            0,
          );
        } else {
          // Light Single or undetected — parse as dimensions
          packagingData = parsePackagingDimensions(rawPackaging);
        }
      } else {
        // BASIC or POLE — parse as dimensions
        packagingData = parsePackagingDimensions(rawPackaging);
      }

      const product: any = {
        mainImage: { url: img },
        qty: Number(flatQtys[flatIdx] || 1),
        productName:
          flatProductNames[flatIdx] && flatProductNames[flatIdx] !== "-"
            ? flatProductNames[flatIdx]
            : "",
        technicalSpecifications: flatSpecs[flatIdx] || [],
        __originalTechnicalSpecifications: flatOrigSpecs[flatIdx] || [],
        commercialDetails: {
          unitCost: flatUnitCosts[flatIdx] || "0",
          pcsPerCarton: flatPcsPerCartons[flatIdx] || "-",
          packaging: packagingData,
          warranty: flatWarranties[flatIdx] || "-",
          factoryAddress: flatFactories[flatIdx] || "-",
          portOfDischarge: flatPorts[flatIdx] || "-",
          // Normalize to internal enum for UI display logic
          commercialType: isLightMultiple ? "LIGHT" : isLightSingle ? "LIGHT" : isPoleType ? "POLE" : isLightType ? "LIGHT" : "BASIC",
          useArrayInput,
          multiRows,
          ...(typeof totalUnitCost === "number" ? { totalUnitCost } : {}),
        },
        supplier: {
          supplierBrand: flatSupplierBrands[flatIdx] || "-",
          company: flatCompanyNames[flatIdx] || "-",
        },
        contact_name: flatContactNames[flatIdx] || "-",
        contact_number: flatContactNumbers[flatIdx] || "-",
        __sellingCost: flatSellingCosts[flatIdx] || "-",
        __leadTime: flatLeadTimes[flatIdx] || "-",
        __priceValidity: formatDateTimeLocal(flatPriceValidities[flatIdx] || null),
        dimensionalDrawing: (() => {
          const u = flatDimDrawings[flatIdx];
          return u && u !== "-" ? { url: u } : null;
        })(),
        illuminanceDrawing: (() => {
          const u = flatIllumDrawings[flatIdx];
          return u && u !== "-" ? { url: u } : null;
        })(),
        productReferenceID: flatProductRefIDs[flatIdx] || null,
        __selectedBranch: flatBranches[flatIdx] || "-",
        __spfRemarksPD: flatSpfRemarksPD[flatIdx] || "-",
        __tdsPdfUrl: flatTdsPdfUrls[flatIdx] || "",
        __tdsBrand:
          flatTdsBrands[flatIdx] && flatTdsBrands[flatIdx] !== "-"
            ? flatTdsBrands[flatIdx]
            : "",
        __tdsProductName:
          flatProductNames[flatIdx] && flatProductNames[flatIdx] !== "-"
            ? flatProductNames[flatIdx]
            : "",
        __isExisting: flatIsExisting[flatIdx] === "true",
        __rowIndex: rowIdx,
      };

      productOffersByRow[rowIdx].push(product);
    }

    return res.status(200).json({
      success: true,
      hasDraft: true,
      draft: {
        spf_number: draft.spf_number,
        referenceid: draft.referenceid,
        tsm: draft.tsm,
        manager: draft.manager,
        draft_author: draft.draft_author,
        item_code: draft.item_code,
        status: draft.status,
        is_edit_mode: draft.is_edit_mode,
        original_spf_number: draft.original_spf_number,
        spf_creation_start_time: draft.spf_creation_start_time,
        date_created: draft.date_created,
        date_updated: draft.date_updated,
        final_unit_cost: (draft as any).final_unit_cost,
        final_subtotal: (draft as any).final_subtotal,
        item_added_date: (draft as any).item_added_date,
        item_added_author: (draft as any).item_added_author,
        revision_remarks: (draft as any).revision_remarks,
        revision_type: (draft as any).revision_type,
        spf_remarks_procurement: (draft as any).spf_remarks_procurement,
        tds_pdf_urls: (draft as any).tds_pdf_urls,
      },
      productOffers: productOffersByRow,
      totalItemRows: rowCount,
    });
  } catch (err: any) {
    console.error(err);
    return res.status(500).json({ message: err.message || "Server error" });
  }
}//heys
