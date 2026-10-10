
require("dotenv").config();

const {
  initializeFirestore,
  getFirestoreDb,
} = require("./src/repositories/firestore");

async function main() {
  const result = initializeFirestore();

  if (!result.db) {
    throw new Error(
      `Firestore initialization failed: ${result.error || "Unknown error"}`
    );
  }

  const db = getFirestoreDb();
  const testDoc = db
    .collection("_connectionTests")
    .doc("local-smoke-test");

  try {
    // 1. Write a temporary test document.
    await testDoc.set({
      message: "ExpiryMitra Firestore test",
      testPassed: true,
      createdAt: new Date().toISOString(),
    });

    console.log("✅ FIRESTORE WRITE SUCCESS");

    // 2. Read the document back.
    const snapshot = await testDoc.get();

    if (!snapshot.exists || snapshot.data().testPassed !== true) {
      throw new Error("Test document was not read back correctly.");
    }

    console.log("✅ FIRESTORE READ SUCCESS");

    // 3. Remove the temporary test document.
    await testDoc.delete();

    console.log("✅ TEST DOCUMENT CLEANED UP");
    console.log("🎉 Firestore read/write test passed!");
  } catch (error) {
    console.error("❌ FIRESTORE TEST FAILED:", error.message);

    // Try to remove the temporary document if one was created.
    try {
      await testDoc.delete();
    } catch {
      // Cleanup may fail if database access is unavailable.
    }

    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("❌ FIRESTORE TEST FAILED:", error.message);
  process.exitCode = 1;
});
