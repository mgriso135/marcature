# Attendance Tracking System (Local Network)

A lightweight, mobile-first system designed to run exclusively on a local network (LAN/Wi-Fi). It allows employees to clock in and out using their own smartphones, without the need to install native applications or purchase dedicated hardware.

## ✨ Key Features

- **Anti-Fraud (Device Binding & User-Agent):** The system uniquely binds the employee's PIN to the device used for the first login via a persistent 10-year cookie. It also integrates a server-side check on the browser's footprint (User-Agent) to block cookie theft and cloning across different devices.
- **In/Out Logic:** Prevents duplicate clock-ins (e.g., two consecutive "IN" logs).
- **Hidden & Secure Admin Panel:** The dashboard (`/la-stanza-dei-bottoni`) is protected by HTTP Basic Auth protocol and allows complete company management.
- **Employee Management:** Add new employees, deactivate accounts, and reset device bindings (useful if an employee changes their phone).
- **Log Management (CRUD):** The administrator can manually add forgotten clock-ins or edit/delete incorrect logs in real-time.
- **Filters & CSV Export:** Dynamic filtering and sorting by employee and date, with automatic `.csv` export of the displayed results, ready for payroll.

## 🛠 Tech Stack

- **Backend:** Node.js + Express
- **Database:** SQLite3 (auto-generated on first run)
- **Template Engine:** Nunjucks (Jinja2 compatible)
- **Frontend:** HTML5, Tailwind CSS (via CDN), Alpine.js (via CDN)

## 🚀 Installation & Setup

### Prerequisites
- [Node.js](https://nodejs.org/) installed on the machine acting as the server.

### 1. Initial Configuration
In the project root, create a `.env` file (if it doesn't exist) and set the administration password:
```env
ADMIN_PASSWORD=your_secret_password
```

### 2. Install Dependencies
Open the terminal in the project folder and run:
```bash
npm install
```

### 3. Start the Server
You can start the server in two ways:
- From the terminal: `npm start`
- On Windows (fast): double-click the `run.bat` file

The server will start and be accessible on port `8000`.

## 🌐 Useful Links

- **Clock-in Interface (for employees):** `http://<SERVER-IP>:8000/`
- **Admin Panel:** `http://<SERVER-IP>:8000/la-stanza-dei-bottoni`
  - *Username:* Anything (e.g., "admin")
  - *Password:* The one set in the `.env` file

## 🔒 Security & Best Practices
Since the app runs on plain HTTP (unencrypted), it is recommended to:
1. **Isolate the Network:** Use a dedicated Wi-Fi network (or one with Client Isolation) solely for attendance tracking, limiting the signal range outside company premises.
2. **Administrative Access:** Access the admin panel (`/la-stanza-dei-bottoni`) directly from the PC acting as the server using `localhost`. This prevents the password (which is only base64 encoded) from traveling over the Wi-Fi network visible to others.
