// Writes public/slate.mobileconfig: an iOS configuration profile holding one Web Clip,
// which puts Slate on the iPhone/iPad home screen and opens it full screen.
// Usage: node scripts/make-profile.mjs [url]     (run again if the address or icon changes)
import fs from "node:fs";

const url = process.argv[2] ?? "https://slate.16888u.com/";
const icon = fs.readFileSync("public/apple-touch-icon.png").toString("base64").replace(/(.{68})/g, "$1\n\t\t\t\t");
// fixed ids: installing a newer copy of the profile replaces the old one instead of adding a second icon
const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>PayloadContent</key>
	<array>
		<dict>
			<key>FullScreen</key>
			<true/>
			<key>IgnoreManifestScope</key>
			<false/>
			<key>IsRemovable</key>
			<true/>
			<key>Label</key>
			<string>Slate</string>
			<key>Precomposed</key>
			<true/>
			<key>URL</key>
			<string>${url}</string>
			<key>Icon</key>
			<data>
				${icon}
			</data>
			<key>PayloadDisplayName</key>
			<string>Slate</string>
			<key>PayloadDescription</key>
			<string>在主畫面加入 Slate。</string>
			<key>PayloadIdentifier</key>
			<string>com.16888u.slate.webclip</string>
			<key>PayloadType</key>
			<string>com.apple.webClip.managed</string>
			<key>PayloadUUID</key>
			<string>6B0C1E52-3A7D-4F0E-9C1B-5D2E8A4F7B61</string>
			<key>PayloadVersion</key>
			<integer>1</integer>
		</dict>
	</array>
	<key>PayloadDisplayName</key>
	<string>Slate</string>
	<key>PayloadDescription</key>
	<string>把 Slate（離線筆記、資料庫與待辦）加到主畫面。這個描述檔只會新增一個圖示，不會更改任何設定，也不會讀取裝置上的資料；隨時可以在「設定 → 一般 → VPN 與裝置管理」移除。</string>
	<key>PayloadIdentifier</key>
	<string>com.16888u.slate</string>
	<key>PayloadOrganization</key>
	<string>Slate (open source)</string>
	<key>PayloadRemovalDisallowed</key>
	<false/>
	<key>PayloadType</key>
	<string>Configuration</string>
	<key>PayloadUUID</key>
	<string>A4D9F3C0-8E21-4B6A-B7F5-1C3E9D2A6048</string>
	<key>PayloadVersion</key>
	<integer>1</integer>
</dict>
</plist>
`;
fs.writeFileSync("public/slate.mobileconfig", xml);
console.log("wrote public/slate.mobileconfig for " + url);
