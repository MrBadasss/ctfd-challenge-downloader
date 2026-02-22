# CTFd Challenge Downloader

A powerful browser extension for Chrome and Edge that streamlines the process of exporting challenge metadata and files from CTFd-based Capture The Flag (CTF) platforms. Perfect for archiving challenges, offline analysis, and creating personal challenge libraries.

## 🚀 Features

- **Smart Scanning**: Automatically discovers all available challenges via CTFd API endpoints (`/api/v1/challenges`)
- **Organized Export**: Maintains the exact platform structure (categories and challenge order)
- **Selective Download**: Advanced filtering by category, solve status (solved/unsolved), or individual challenge selection
- **Flexible Export Modes**: 
  - **Direct File Export** (recommended): Downloads each file individually for better reliability
  - **ZIP Archive**: Creates a single compressed file for smaller challenge sets
- **Background Processing**: Export continues seamlessly even when the popup is closed
- **Progress Tracking**: Real-time progress updates with persistent state across browser sessions
- **Detailed Status**: Per-challenge success, skip, and failure tracking with error details
- **Robust Error Handling**: Automatic retry mechanism (up to 3 attempts) with intelligent fallback strategies
- **External File Support**: Handles both platform-hosted and externally-linked challenge files

## 📦 Installation

### Manual Installation (Developer Mode)

1. **Download the Extension**
   - Clone this repository: `git clone https://github.com/MrBadasss/ctfd-challenge-downloader.git`
   - Or download as ZIP and extract

2. **Open Extension Management Page**
   - **Chrome**: Navigate to `chrome://extensions` or Menu → Extensions → Manage Extensions
   - **Edge**: Navigate to `edge://extensions` or Menu → Extensions

3. **Enable Developer Mode**
   - Toggle the "Developer mode" switch in the top-right corner

4. **Load the Extension**
   - Click **Load unpacked**
   - Navigate to and select the extension folder (containing `manifest.json`)
   - The extension icon should appear in your browser toolbar

## 📖 Usage Guide

### Initial Setup

**Important Browser Configuration** (Recommended):

To avoid being prompted for each file download location:
1. Open your browser settings
2. Navigate to Downloads settings:
   - **Chrome**: `chrome://settings/downloads`
   - **Edge**: `edge://settings/downloads`
3. **Disable** the option: "Ask where to save each file before downloading"
4. Set your preferred default download location

### First-Time Use

1. **Log in** to your CTFd platform
2. **Click** the extension icon in your browser toolbar
3. **Click "Scan Challenges"** button

**⚠️ First-Time Permission Prompt:**
- On your first scan, the browser will ask for permission to access the CTFd site
- The extension popup will close automatically after granting permission
- Simply **click the extension icon again** and click "Scan Challenges" - it will now work

### Basic Workflow

1. **Navigate & Login**
   - Open your CTFd platform in any tab
   - Ensure you're logged in (no need to be on a specific page)

2. **Scan Challenges**
   - Click the extension icon
   - Click **"Scan Challenges"** to discover all available challenges
   - Wait for the scan to complete (usually takes a few seconds)

3. **Select Challenges**
   - **All Challenges**: Leave all options checked (default)
   - **By Category**: Uncheck categories you want to exclude
   - **By Status**: Use "Solved" or "Unsolved" filter
   - **Individual Selection**: Manually check/uncheck specific challenges

4. **Choose Export Options**
   - **Export Mode**: Select "Direct Files" (recommended) or "ZIP Archive"
   - **Include Files**: Toggle to include/exclude challenge attachments
   - **Include Metadata**: Toggle to include/exclude README files with challenge details

5. **Start Export**
   - Click **"Export Selected"**
   - Monitor progress in the popup
   - Downloads continue even if you close the popup

### Download Organization

All exported files are automatically organized in a clear, structured format:

```
[Platform Name]/
├── Category 1/
│   ├── Challenge 1/
│   │   ├── README.md          # Challenge details, hints, and description
│   │   ├── attachment1.zip    # Challenge files
│   │   └── attachment2.txt
│   ├── Challenge 2/
│   │   ├── README.md
│   │   └── files...
│   └── Challenge 3/
└── Category 2/
    ├── Challenge 4/
    └── Challenge 5/
```

**README.md Contents:**
- Challenge name and description
- Category and difficulty
- Point value
- Solve count
- Hints (if any)
- File attachments list
- External links (marked for manual download if unreachable)

## ⚙️ Technical Details

### API Interaction
- Scans `/api/v1/challenges` for challenge list
- Fetches individual challenge details from `/api/v1/challenges/{id}`
- Respects platform authentication and permissions
- Works with any standard CTFd installation

### Reliability Features
- **Retry Logic**: Failed requests are automatically retried up to 3 times with exponential backoff
- **Timeout Protection**: 10-minute maximum timeout per request to prevent hanging
- **Smart Fallback**: ZIP mode automatically switches to direct file mode if archive size exceeds safe limits
- **External Link Handling**: Attempts to download external files via fetch; lists unreachable URLs in README under "Manual Check Required"
- **Error Details**: Failed downloads include specific error messages for troubleshooting

### Performance
- Background processing using service worker (Manifest V3)
- Asynchronous operations for non-blocking UI
- Progress persistence across browser restarts
- Efficient memory usage for large challenge sets

## 🛡️ Permissions

This extension requires the following permissions with specific purposes:

| Permission | Purpose |
|------------|---------|
| `activeTab` | Read challenge data from the active CTFd tab |
| `scripting` | Inject scripts to interact with CTFd API |
| `downloads` | Save challenge files to your computer |
| `storage` | Persist progress, settings, and scan results |
| `unlimitedStorage` | Handle large challenge sets without quota limits |
| `optional_host_permissions` (https://*/* and http://*/*) | Download external challenge files from any domain |

**Privacy Note**: This extension operates entirely locally. No data is sent to external servers. All API calls are made directly to your CTFd platform.

## 🔧 Troubleshooting

### Common Issues

**"Permission denied" or popup closes on first scan:**
- This is expected behavior on first use
- Grant the permission when prompted
- Click the extension icon again to rescan

**Downloads not starting:**
- Check if browser's download setting blocks automatic downloads
- Verify you're logged into the CTFd platform
- Check browser console (F12) for error messages

**Some files failing to download:**
- External links may have CORS restrictions
- Check the generated README.md for "Manual Check Required" section
- Some files may require authentication cookies

**Extension not detecting challenges:**
- Ensure the site is running standard CTFd (compatible API)
- Check if you have permission to view challenges
- Verify network connection

## 🤝 Contributing

Contributions are welcome and appreciated! Here's how you can help:

### Ways to Contribute
- 🐛 Report bugs and issues
- 💡 Suggest new features or improvements
- 📝 Improve documentation
- 🔧 Submit pull requests with fixes or enhancements

### Development Setup
1. Fork this repository
2. Create a feature branch: `git checkout -b feature-name`
3. Make your changes and test thoroughly
4. Commit with clear messages: `git commit -m "feat: add new feature"`
5. Push to your fork: `git push origin feature-name`
6. Open a Pull Request

### Code Style
- Follow existing code formatting
- Comment complex logic
- Test all changes in both Chrome and Edge
- Ensure no console errors

## 📄 License

This project is open source and available under the [MIT License](LICENSE).

You are free to use, modify, and distribute this software as long as you include the original copyright and license notice.

## ⚠️ Disclaimer

This tool is intended for **legitimate educational and archival purposes only**. 

**Important Notes:**
- Only use on platforms where you have **authorized access**
- Respect platform **Terms of Service** and usage policies
- Only download content you have **permission to access**
- Do not use for unauthorized data extraction or competitive advantage
- The developers are not responsible for misuse of this tool

**Ethical Use**: This extension is designed to help participants archive challenges for learning purposes, not to circumvent platform rules or share restricted content.

## 📞 Support

- **Issues**: Report bugs or request features via [GitHub Issues](https://github.com/MrBadasss/ctfd-challenge-downloader/issues)
- **Discussions**: Ask questions or share ideas in [GitHub Discussions](https://github.com/MrBadasss/ctfd-challenge-downloader/discussions)

---

**Made with 💙 for the CTF community**
