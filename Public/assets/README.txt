How to use this starter (Cloudflare Pages):
1) Put your real assets into /assets:
   - headshot.jpg
   - stretched-cluster-diagram.png
   - avd-overview.png
   - jumpcloud-ad.png
   - failover-runbook.pdf
   - avd-project-plan.pdf
   - jumpcloud-to-ad-checklist.pdf
   - Elle-Held-Resume.pdf

2) Update any filenames in portfolio.html and resume.html if you changed names.

3) Zip the folder and deploy via Workers & Pages → Create application → Pages → Direct upload.

4) Attach your custom domain (preferably move DNS to Cloudflare for easy apex).

Design notes:
- Clean white theme, two-column intro with round headshot (stacks on mobile).
- Portfolio has inline PDF viewer using <object>, with download fallback.
- No frameworks, only static HTML/CSS.
