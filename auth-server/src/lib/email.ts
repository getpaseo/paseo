import { Resend } from "resend";

let _resend: Resend | null = null;

function getResend(): Resend | null {
  if (!process.env.RESEND_API_KEY) return null;
  if (!_resend) _resend = new Resend(process.env.RESEND_API_KEY);
  return _resend;
}

const FROM_EMAIL = process.env.RESEND_FROM_EMAIL || "Hubcode <noreply@hubcode.ai>";
const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3002";

/**
 * Send an organization invitation email via Resend.
 */
export async function sendInvitationEmail({
  to,
  inviterName,
  organizationName,
  orgId,
  invitationId,
  role,
}: {
  to: string;
  inviterName: string;
  organizationName: string;
  orgId: string;
  invitationId: string;
  role: string;
}) {
  const resend = getResend();
  if (!resend) {
    console.warn("[email] RESEND_API_KEY not set — skipping email send");
    return { success: false, error: "RESEND_API_KEY not configured" };
  }

  const acceptUrl = `${APP_URL}/invite/accept?id=${invitationId}&org=${orgId}`;

  try {
    const { data, error } = await resend.emails.send({
      from: FROM_EMAIL,
      to,
      subject: `You've been invited to join ${organizationName} on Hubcode`,
      html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
</head>
<body style="margin:0;padding:0;background-color:#080808;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#080808;padding:40px 20px;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="background-color:#111111;border-radius:12px;border:1px solid #1a1a1a;overflow:hidden;">
          <!-- Header -->
          <tr>
            <td style="padding:32px 40px 0;">
              <div style="display:inline-flex;align-items:center;gap:8px;">
                <div style="width:28px;height:28px;background-color:#c026d3;border-radius:6px;display:inline-block;text-align:center;line-height:28px;color:white;font-weight:700;font-size:14px;">H</div>
                <span style="color:#ffffff;font-size:16px;font-weight:600;vertical-align:middle;padding-left:8px;">Hubcode</span>
              </div>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:32px 40px;">
              <h1 style="margin:0 0 16px;color:#ffffff;font-size:20px;font-weight:600;">
                You've been invited to join a team
              </h1>
              <p style="margin:0 0 24px;color:#a1a1a1;font-size:14px;line-height:1.6;">
                <strong style="color:#e5e5e5;">${inviterName}</strong> has invited you to join
                <strong style="color:#e5e5e5;">${organizationName}</strong> as a
                <strong style="color:#c026d3;">${role}</strong> on Hubcode.
              </p>

              <!-- CTA Button -->
              <table cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
                <tr>
                  <td style="background-color:#c026d3;border-radius:8px;">
                    <a href="${acceptUrl}"
                       style="display:inline-block;padding:12px 32px;color:#ffffff;font-size:14px;font-weight:600;text-decoration:none;">
                      Accept Invitation
                    </a>
                  </td>
                </tr>
              </table>

              <p style="margin:0 0 8px;color:#666666;font-size:12px;line-height:1.5;">
                This invitation expires in 7 days. If you didn't expect this email, you can safely ignore it.
              </p>

              <p style="margin:0;color:#444444;font-size:11px;word-break:break-all;">
                ${acceptUrl}
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:20px 40px;border-top:1px solid #1a1a1a;">
              <p style="margin:0;color:#555555;font-size:11px;">
                Sent by Hubcode &middot; You received this because someone invited you to their team.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
      `.trim(),
    });

    if (error) {
      console.error("[email] Resend error:", error);
      return { success: false, error };
    }

    console.log("[email] Invitation sent to", to, "id:", data?.id);
    return { success: true, id: data?.id };
  } catch (err) {
    console.error("[email] Failed to send invitation:", err);
    return { success: false, error: err };
  }
}
