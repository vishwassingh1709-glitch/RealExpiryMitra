
const { getApps } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const storeRepo = require("../repositories/store.repository");

const FIREBASE_AUTH_URL =
  "https://identitytoolkit.googleapis.com/v1/accounts";

class AuthError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "AuthError";
    this.status = status;
  }
}

function assertAuthConfigured() {
  if (!getApps().length || !process.env.FIREBASE_WEB_API_KEY) {
    throw new AuthError(
      503,
      "Firebase Authentication is not configured. Set the Firebase Admin credentials and FIREBASE_WEB_API_KEY."
    );
  }
}

async function identityToolkit(operation, payload) {
  const url =
    `${FIREBASE_AUTH_URL}:${operation}` +
    `?key=${encodeURIComponent(process.env.FIREBASE_WEB_API_KEY)}`;

  let response;

  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ...payload,
        returnSecureToken: true,
      }),
    });
  } catch (error) {
    // Never log the request URL because it contains the Web API key.
    console.error("[Auth] Identity Toolkit network error:", {
      operation,
      name: error?.name || "UnknownError",
    });

    throw new AuthError(
      502,
      "Firebase Authentication could not be reached. Please try again."
    );
  }

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const code = data.error?.message || "UNKNOWN_ERROR";

    // Log only the operation, HTTP status, and provider error code.
    // Never log passwords, tokens, or the request URL.
    console.warn("[Auth] Identity Toolkit rejected request:", {
      operation,
      httpStatus: response.status,
      providerCode: code,
    });

    if (code === "EMAIL_EXISTS") {
      throw new AuthError(
        409,
        "An account with this email already exists."
      );
    }

    if (
      [
        "INVALID_LOGIN_CREDENTIALS",
        "EMAIL_NOT_FOUND",
        "INVALID_PASSWORD",
        "USER_DISABLED",
      ].includes(code)
    ) {
      throw new AuthError(
        401,
        "Email or password is incorrect."
      );
    }

    if (code.startsWith("WEAK_PASSWORD")) {
      throw new AuthError(
        400,
        "Choose a stronger password with at least 6 characters."
      );
    }

    if (code === "TOO_MANY_ATTEMPTS_TRY_LATER") {
      throw new AuthError(
        429,
        "Too many attempts. Wait a little and try again."
      );
    }

    if (code === "OPERATION_NOT_ALLOWED") {
      throw new AuthError(
        503,
        "Email/Password authentication is not enabled in Firebase."
      );
    }

    if (
      code === "API_KEY_INVALID" ||
      code === "INVALID_API_KEY"
    ) {
      throw new AuthError(
        503,
        "The Firebase Web API key is invalid. Check the project configuration."
      );
    }

    if (code === "CONFIGURATION_NOT_FOUND") {
      throw new AuthError(
        503,
        "Firebase Authentication is not configured for this project."
      );
    }

    throw new AuthError(
      400,
      "Firebase could not complete this authentication request."
    );
  }

  return data;
}

async function ensureStoreProfile(uid, profile = {}) {
  return storeRepo.createStoreIfMissing(uid, {
    store_name: profile.store_name || "My Store",
    owner_name: profile.owner_name || "Store owner",
    owner_uid: uid,
    email: profile.email || "",
  });
}

function authResponse(identity, user) {
  return {
    idToken: identity.idToken,
    expiresIn: identity.expiresIn,
    user: {
      uid: user.uid,
      email: user.email || "",
      displayName: user.displayName || "",
      store_id: user.uid,
    },
  };
}

async function signUp({ name, store_name, email, password }) {
  assertAuthConfigured();

  const normalizedEmail = String(email || "")
    .trim()
    .toLowerCase();

  const displayName = String(name || "").trim();
  const storeName = String(store_name || "").trim();

  if (
    !displayName ||
    !storeName ||
    !normalizedEmail ||
    !password
  ) {
    throw new AuthError(
      400,
      "Name, store name, email, and password are required."
    );
  }

  // Correct email validation: the dot before the domain
  // extension is escaped once.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    throw new AuthError(400, "Enter a valid email address.");
  }

  if (String(password).length < 6) {
    throw new AuthError(
      400,
      "Choose a password with at least 6 characters."
    );
  }

  let userRecord;

  try {
    userRecord = await getAuth().createUser({
      email: normalizedEmail,
      password: String(password),
      displayName,
      disabled: false,
    });

    await getAuth().setCustomUserClaims(userRecord.uid, {
      store_id: userRecord.uid,
      role: "shopkeeper",
    });

    await ensureStoreProfile(userRecord.uid, {
      store_name: storeName,
      owner_name: displayName,
      email: normalizedEmail,
    });

    // Obtain a Firebase ID token for the newly created user.
    const identity = await identityToolkit("signInWithPassword", {
      email: normalizedEmail,
      password: String(password),
    });

    return authResponse(identity, userRecord);
  } catch (error) {
    // Safe diagnostics for Render/local logs.
    // Do not log request bodies, passwords, or tokens.
    console.error("[Auth] Signup failed:", {
      name: error?.name || "Error",
      code: error?.code || null,
      status: error?.status || null,
      message: String(error?.message || "Unknown error")
        .replace(/AIza[0-9A-Za-z_-]+/g, "[REDACTED_API_KEY]"),
    });

    // Preserve the existing rollback behaviour.
    if (userRecord) {
      await storeRepo
        .deleteStoreIfOwned(userRecord.uid, userRecord.uid)
        .catch(() => {});

      await getAuth()
        .deleteUser(userRecord.uid)
        .catch(() => {});
    }

    if (error instanceof AuthError) {
      throw error;
    }

    if (error.code === "auth/email-already-exists") {
      throw new AuthError(
        409,
        "An account with this email already exists."
      );
    }

    throw new AuthError(
      500,
      "Your account could not be created. Please try again."
    );
  }
}

async function signIn({ email, password }) {
  assertAuthConfigured();

  const normalizedEmail = String(email || "")
    .trim()
    .toLowerCase();

  if (
    !normalizedEmail ||
    !password ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)
  ) {
    throw new AuthError(
      400,
      "Enter your email and password."
    );
  }

  const identity = await identityToolkit("signInWithPassword", {
    email: normalizedEmail,
    password: String(password),
  });

  let userRecord;

  try {
    userRecord = await getAuth().getUser(identity.localId);
  } catch (error) {
    console.error("[Auth] User verification failed:", {
      code: error?.code || null,
      name: error?.name || "Error",
    });

    throw new AuthError(
      401,
      "This account could not be verified."
    );
  }

  const claims = userRecord.customClaims || {};

  if (claims.role && claims.role !== "shopkeeper") {
    throw new AuthError(
      403,
      "This account does not have access to a store workspace."
    );
  }

  if (
    claims.store_id &&
    claims.store_id !== userRecord.uid
  ) {
    throw new AuthError(
      403,
      "This account is linked to a different store workspace."
    );
  }

  if (!claims.role || !claims.store_id) {
    await getAuth().setCustomUserClaims(userRecord.uid, {
      ...claims,
      store_id: userRecord.uid,
      role: "shopkeeper",
    });

    await ensureStoreProfile(userRecord.uid, {
      owner_name: userRecord.displayName,
      email: userRecord.email,
    });

    // Refresh the token so that it can include the updated claims.
    const refreshedIdentity = await identityToolkit(
      "signInWithPassword",
      {
        email: normalizedEmail,
        password: String(password),
      }
    );

    return authResponse(refreshedIdentity, userRecord);
  }

  return authResponse(identity, userRecord);
}

module.exports = {
  AuthError,
  signUp,
  signIn,
};
