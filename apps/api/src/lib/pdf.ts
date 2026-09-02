// GST tax invoice PDF (3.6 "printed and WhatsApp PDF", Section 14 print templates).
//
// Everything on the page comes from the branch and invoice records — there is no
// hard-coded shop name, address or phone number, because the same binary serves
// every branch in the chain and a wrong GSTIN on a tax invoice is a compliance
// problem, not a cosmetic one.
import PDFDocument from 'pdfkit';

interface Line {
  product_name: string; hsn_code: string; unit_label: string;
  qty_in_sale_unit: number | string; rate_locked_at_scan: number | string;
  discount_amount: number | string; taxable_value: number | string;
  cgst_amount: number | string; sgst_amount: number | string; igst_amount: number | string;
  line_total: number | string;
}

const money = (v: unknown) => Number(v ?? 0).toLocaleString('en-IN', {
  minimumFractionDigits: 2, maximumFractionDigits: 2,
});

/** Amount in words — Indian numbering, required on a tax invoice by convention. */
function inWords(amount: number): string {
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
    'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  const two = (n: number): string =>
    n < 20 ? ones[n] : `${tens[Math.floor(n / 10)]}${n % 10 ? ' ' + ones[n % 10] : ''}`;
  const three = (n: number): string =>
    n >= 100 ? `${ones[Math.floor(n / 100)]} Hundred${n % 100 ? ' ' + two(n % 100) : ''}` : two(n);

  const rupees = Math.floor(Math.abs(amount));
  const paise = Math.round((Math.abs(amount) - rupees) * 100);
  if (rupees === 0 && paise === 0) return 'Zero Rupees Only';

  const parts: string[] = [];
  const crore = Math.floor(rupees / 10000000);
  const lakh = Math.floor((rupees % 10000000) / 100000);
  const thousand = Math.floor((rupees % 100000) / 1000);
  const rest = rupees % 1000;
  if (crore) parts.push(`${three(crore)} Crore`);
  if (lakh) parts.push(`${three(lakh)} Lakh`);
  if (thousand) parts.push(`${three(thousand)} Thousand`);
  if (rest) parts.push(three(rest));

  let out = parts.join(' ') + ' Rupees';
  if (paise) out += ` and ${two(paise)} Paise`;
  return out + ' Only';
}

export async function generateInvoicePdf(
  invoice: any, lines: Line[], payments: any[] = [],
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 40 });
      const chunks: Buffer[] = [];
      doc.on('data', (c) => chunks.push(c as Buffer));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const left = 40;
      const right = 555;
      const isGst = invoice.invoice_type === 'GST';
      const hasIgst = Number(invoice.igst_total ?? 0) > 0;

      // ── Header ──────────────────────────────────────────────────────────
      doc.font('Helvetica-Bold').fontSize(16).text(invoice.branch_name ?? 'Hardware Store', left, 40);
      doc.font('Helvetica').fontSize(9).fillColor('#444');
      if (invoice.branch_address) doc.text(invoice.branch_address, left, doc.y + 2, { width: 300 });
      if (invoice.branch_phone) doc.text(`Phone: ${invoice.branch_phone}`, left, doc.y + 1);
      if (invoice.branch_gstin) doc.text(`GSTIN: ${invoice.branch_gstin}`, left, doc.y + 1);

      doc.font('Helvetica-Bold').fontSize(13).fillColor('#000')
         .text(isGst ? 'TAX INVOICE' : 'BILL OF SUPPLY', 300, 44, { width: 255, align: 'right' });
      doc.font('Helvetica').fontSize(9).fillColor('#444')
         .text(`Invoice No: ${invoice.invoice_number ?? '—'}`, 300, doc.y + 4, { width: 255, align: 'right' })
         .text(`Date: ${new Date(invoice.server_received_at ?? Date.now()).toLocaleString('en-IN')}`,
               300, doc.y + 1, { width: 255, align: 'right' });
      if (invoice.status === 'VOID') {
        doc.font('Helvetica-Bold').fillColor('#c00').fontSize(11)
           .text('VOID', 300, doc.y + 2, { width: 255, align: 'right' });
      }

      let y = Math.max(doc.y, 120) + 10;
      doc.moveTo(left, y).lineTo(right, y).lineWidth(1).strokeColor('#999').stroke();
      y += 12;

      // ── Customer ────────────────────────────────────────────────────────
      doc.fillColor('#000').font('Helvetica-Bold').fontSize(9).text('Billed To', left, y);
      doc.font('Helvetica').fillColor('#333')
         .text(invoice.customer_name ?? 'Walk-in customer', left, y + 13);
      if (invoice.customer_phone) doc.text(invoice.customer_phone, left, doc.y + 1);
      if (invoice.customer_gstin) doc.text(`GSTIN: ${invoice.customer_gstin}`, left, doc.y + 1);
      if (invoice.place_of_supply_state_code) {
        doc.text(`Place of supply: ${invoice.place_of_supply_state_code}`, 350, y + 13, { width: 205, align: 'right' });
      }
      y = doc.y + 14;

      // ── Line table ──────────────────────────────────────────────────────
      const cols = hasIgst
        ? [{ x: left, w: 168, label: 'Item', align: 'left' as const },
           { x: 208, w: 44, label: 'HSN', align: 'left' as const },
           { x: 252, w: 44, label: 'Qty', align: 'right' as const },
           { x: 296, w: 58, label: 'Rate', align: 'right' as const },
           { x: 354, w: 66, label: 'Taxable', align: 'right' as const },
           { x: 420, w: 60, label: 'IGST', align: 'right' as const },
           { x: 480, w: 75, label: 'Amount', align: 'right' as const }]
        : [{ x: left, w: 158, label: 'Item', align: 'left' as const },
           { x: 198, w: 42, label: 'HSN', align: 'left' as const },
           { x: 240, w: 42, label: 'Qty', align: 'right' as const },
           { x: 282, w: 54, label: 'Rate', align: 'right' as const },
           { x: 336, w: 60, label: 'Taxable', align: 'right' as const },
           { x: 396, w: 52, label: 'CGST', align: 'right' as const },
           { x: 448, w: 52, label: 'SGST', align: 'right' as const },
           { x: 500, w: 55, label: 'Amount', align: 'right' as const }];

      const header = () => {
        doc.rect(left, y, right - left, 18).fillColor('#f0f0f0').fill();
        doc.fillColor('#000').font('Helvetica-Bold').fontSize(8);
        cols.forEach((c) => doc.text(c.label, c.x + 2, y + 5, { width: c.w - 4, align: c.align }));
        y += 18;
        doc.font('Helvetica').fontSize(8);
      };
      header();

      for (const l of lines) {
        // Page breaks are handled explicitly so a long bill does not overrun the
        // footer or lose its column headings.
        if (y > 690) { doc.addPage(); y = 50; header(); }
        const cells = hasIgst
          ? [l.product_name, l.hsn_code ?? '', `${Number(l.qty_in_sale_unit)} ${l.unit_label ?? ''}`,
             money(l.rate_locked_at_scan), money(l.taxable_value), money(l.igst_amount), money(l.line_total)]
          : [l.product_name, l.hsn_code ?? '', `${Number(l.qty_in_sale_unit)} ${l.unit_label ?? ''}`,
             money(l.rate_locked_at_scan), money(l.taxable_value), money(l.cgst_amount),
             money(l.sgst_amount), money(l.line_total)];
        const height = doc.heightOfString(String(cells[0]), { width: cols[0].w - 4 });
        cols.forEach((c, i) => doc.fillColor('#222').text(String(cells[i]), c.x + 2, y + 3, { width: c.w - 4, align: c.align }));
        y += Math.max(height, 11) + 5;
        doc.moveTo(left, y - 2).lineTo(right, y - 2).lineWidth(0.3).strokeColor('#ddd').stroke();
      }

      // ── Totals ──────────────────────────────────────────────────────────
      if (y > 620) { doc.addPage(); y = 50; }
      y += 8;
      const totalRow = (label: string, value: string, bold = false) => {
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 10 : 9).fillColor('#000');
        doc.text(label, 340, y, { width: 120, align: 'right' });
        doc.text(value, 465, y, { width: 90, align: 'right' });
        y += bold ? 16 : 13;
      };
      totalRow('Taxable value', money(invoice.subtotal));
      if (Number(invoice.discount_total ?? 0) > 0) totalRow('Discount', `- ${money(invoice.discount_total)}`);
      if (isGst && hasIgst) totalRow('IGST', money(invoice.igst_total));
      if (isGst && !hasIgst) {
        totalRow('CGST', money(invoice.cgst_total));
        totalRow('SGST', money(invoice.sgst_total));
      }
      if (Number(invoice.round_off ?? 0) !== 0) totalRow('Round off', money(invoice.round_off));
      doc.moveTo(340, y).lineTo(right, y).lineWidth(0.8).strokeColor('#666').stroke();
      y += 6;
      const payable = Number(invoice.grand_total ?? 0) + Number(invoice.round_off ?? 0);
      totalRow('Total', `Rs. ${money(payable)}`, true);

      doc.font('Helvetica-Oblique').fontSize(8).fillColor('#444')
         .text(inWords(payable), left, y - 30, { width: 290 });

      // ── Payments (3.2 split payment shown explicitly) ───────────────────
      y += 10;
      if (payments.length) {
        doc.font('Helvetica-Bold').fontSize(8).fillColor('#000').text('Payment', left, y);
        y += 12;
        doc.font('Helvetica').fillColor('#333');
        for (const p of payments) {
          doc.text(`${p.method}${p.ref_no ? ` (${p.ref_no})` : ''}: Rs. ${money(p.amount)}`, left, y);
          y += 11;
        }
      }

      // ── Footer ──────────────────────────────────────────────────────────
      const footerY = Math.max(y + 20, 740);
      doc.font('Helvetica').fontSize(7).fillColor('#777')
         .text(isGst
           ? 'This is a computer-generated tax invoice. Tax is computed per line and rounded to two decimals (half-up).'
           : 'This is a computer-generated bill of supply. No GST has been charged on this transaction.',
           left, footerY, { width: right - left, align: 'center' });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
