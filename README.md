# Product Image Scraper Browser Extension

**Product Image Scraper** is a powerful browser extension designed to find and download **high-resolution product images** from e-commerce websites. 🛍️ It intelligently scans pages, transforms thumbnail URLs into their full-size versions, and processes them into clean, uniformly sized JPEG files, ready for use.

The extension is built to streamline the workflow for anyone needing to collect product imagery, such as e-commerce managers, marketers, or designers. It prioritizes finding the best possible images from a page's main gallery while filtering out irrelevant logos, icons, and tracking pixels.

---

### Installation

## Install directly for Firefox
[➜ Click to install Product Image Scraper](https://addons.mozilla.org/firefox/downloads/file/4587786/f56e0e01aa1c4855a8b4-0.8.0.xpi)

---

## Temporary install for Firefox
[**Download the Latest Release**](https://github.com/Gurglamesh/Product-Image-Scraper/releases/latest)

1) **Load it temporarily in Firefox**
   - Open Firefox and go to: `about:debugging#/runtime/this-firefox`
   - Click **Load Temporary Add-on…**
   - Choose the unzipped folder’s **`manifest.json`**

2) **Use it**
   - The extension icon appears in the toolbar. Open a product page and click the icon to use it.

> ⚠️ **Temporary only:** Debug-loaded add-ons are removed on **every browser restart**.


---

## Key Features

### Comprehensive Scraping
The extension goes beyond simple `<img>` tags. It scans for images within **`srcset` attributes**, **CSS backgrounds**, **JSON-LD metadata**, and even raw `<script>` tags to find every possible product shot.

### Smart URL Transformation
It uses a set of configurable rules to intelligently guess high-resolution image URLs from thumbnails. For example, it can transform `.../product/100x100/image.jpg` into `.../product/1600x900/image.jpg` or remove query parameters like `?w=150`.

### Image Processing & Normalization
All downloaded images are processed for **consistency**. Each image is centered within a **1000x1000 pixel white canvas** and saved as a **high-quality JPEG**. This ensures all your final images have a uniform size and format.

### Intelligent Filtering & Deduplication

* **Heuristic Background Removal:** An optional feature attempts to automatically remove plain white backgrounds from product shots, making them transparent before placing them on the final white canvas.
* **Duplicate Detection:** The extension calculates a **hash** of each processed image to avoid saving visually identical duplicates, even if they come from different URLs (e.g., a `.png` and a `.jpg` of the same image).
* **Size Filtering:** Users can opt to only see images that meet a minimum size threshold, filtering out small icons and thumbnails.

### User-Friendly Interface
The popup provides a clear grid of all found images. Users can easily select the images they want, and a counter keeps track of the selection. The order in which images are selected determines their final filename (e.g., `01_product-name.jpg`, `02_product-name.jpg`).

### Advanced Customization
For tricky websites, users can provide their own **Custom CSS Selectors**. Images found within these selectors are given top priority, ensuring the extension always pulls from the main product gallery first.

### Domain-Specific Activation
The extension only runs on websites you **explicitly enable** it on. This respects user privacy and saves system resources. It can also be configured to open its popup automatically when you visit an enabled site.

---

## How It Works

1.  **Navigate** to a product page on an e-commerce site.
2.  **Click** the extension icon in your browser's toolbar.
3.  **Activate the Extension:** In the popup's toolbar, check the box labeled **"Aktivera på [domain name]"** (Enable on...). This only needs to be done once per domain. The popup will then reload and start searching for images.
4.  **Review and Filter:** The popup will display all the images it found. You can use the filter checkboxes at the top to refine the results, such as **"Visa endast stora bilder"** (Show only large images) or **"Dölj dubbletter"** (Hide duplicates).
5.  **Select Images:** Click on the images you want to download. A blue border and a number will appear, indicating the selection and its order. You can use the **"Markera alla"** (Select All) and **"Avmarkera alla"** (Deselect All) buttons for convenience.
6.  **Download:** Click the blue **"Spara valda"** (Save Selected) button.
7.  **Done!** 🎉 The extension will process each selected image and save them into a new folder named after the product (e.g., `Awesome T-Shirt/01_Awesome T-Shirt.jpg`).

---

## Installing for Development/Testing (Firefox)

If you want to test a development branch or install the extension directly from the source code, you can load it as a **temporary add-on** in Firefox.

1.  **Download the Source Code:** Download the project files as a `.zip` file and extract them to a folder on your computer.
2.  **Open Firefox** and navigate to the following URL: `about:debugging`
3.  **Navigate to Add-ons:** In the left-hand sidebar, click on **"This Firefox"**.
4.  **Load the Add-on:** Click the **"Load Temporary Add-on..."** button.
5.  **Select the Manifest:** A file dialog will open. Navigate into the folder where you extracted the source code and select the **`manifest.json`** file.

The extension will now be installed and active.

> **Note:** Temporary add-ons are only active until you close Firefox. You will need to repeat this process every time you restart the browser.