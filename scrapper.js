const { chromium } = require('playwright');

const STORYGRAPH_BASE_URL = process.env.STORYGRAPH_BASE_URL;
const STORYGRAPH_ID = process.env.STORYGRAPH_ID;
const AWS_REGION = process.env.AWS_REGION;
const AWS_S3_BUCKET_NAME = process.env.AWS_S3_BUCKET_NAME;
const AWS_S3_BUCKET_DIR = process.env.AWS_S3_BUCKET_DIR;

const BOOKS_PROFILE_URL = `${STORYGRAPH_BASE_URL}/profile${STORYGRAPH_ID}`;

(async () => {
    const browser = await chromium.launch({
        headless: true,
        args: [
            '--no-first-run',
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-extensions'
        ],
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        locale: 'en-US',
        timezoneId: 'America/America/Los_Angeles',
        viewport: { width: 1440, height: 850 },

    });
    const page = await browser.newPage();
    await page.goto(BOOKS_PROFILE_URL);
    await page.waitForSelector('#navbar');
    console.log(await page.title());
    await browser.close();
})();

// const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

// const s3 = new S3Client({ region: AWS_REGION });

// (async () => {
//     await s3.send(new PutObjectCommand({
//         Bucket: AWS_S3_BUCKET_NAME,
//         Key: `${AWS_S3_BUCKET_DIR}/test.json`,
//         Body: JSON.stringify({ ok: true, test: 'my-data' }),
//         ContentType: "application/json"
//     })).then((res) => {
//         console.log(res);
//     });
// })();