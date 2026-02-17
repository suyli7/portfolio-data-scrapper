const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { chromium } = require('playwright-core');
const chromiumLambda = require('@sparticuz/chromium');
require('dotenv').config({ quiet: true });

const BOOKS_BASE_URL = process.env.BOOKS_BASE_URL;
const BOOKS_ID = process.env.BOOKS_ID;
const GAMES_URL = process.env.GAMES_URL;
const GAME_SEARCH_BASE_URL = "https://thegamesdb.net/search.php?name=";
const S3_REGION = process.env.S3_REGION;
const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME;
const S3_BUCKET_DIR = process.env.S3_BUCKET_DIR;
const IS_DEV = process.env.IS_DEV;
const DEV_CHROMIUM_PATH = process.env.DEV_CHROMIUM_PATH;
const ARGV = process.argv;
const S3_UPLOAD_FLAG = '--s3-upload';

const isEmpty = (value) => {
    if (Array.isArray(value)) {
        return value.length === 0;
    }
    return false;
}

const parseBookData = async (linkEl, imgEl, editionInfoEl) => {
    const linkHref = await linkEl.getAttribute('href');
    const imgMeta = await imgEl.getAttribute('alt');
    const imgUrl = await imgEl.getAttribute('src');
    const [title, author] = imgMeta.split(' by ');
    const bookUrl = `${BOOKS_BASE_URL}${linkHref}`;
    let publishYear = '';

    if (editionInfoEl) {
        const editionInfo = await editionInfoEl.innerText();
        const yearMatch = editionInfo?.match(/\b(18|19|20)\d{2}\b/);
        publishYear = yearMatch ? yearMatch[0] : null;
    }

    return { title, author, bookUrl, imgUrl, publishYear };
}

const parseBooksProfileSectionData = async (page) => {
    const parseSectionBooks = async (section) => {
        const bookLinkEls = await section.$$('a.book-page-link');
        const data = [];

        for (const linkEl of bookLinkEls) {
            const imgEl = await linkEl.$('img');
            const bookData = await parseBookData(linkEl, imgEl);

            data.push(bookData);
        }

        return data;
    };

    const sections = await page.$$('div.container .standard-pane > div');
    const summaryPane = await page.$(`div.container .standard-pane:has(button:text("Stats"))`);
    if (!sections || !sections.length) {
        console.log('Err: Unable to parse sections');
        return;
    }
    if (!summaryPane) {
        console.log('Err: Unable to parse summary');

    }
    let readStyleSummary = '';
    const readStyleSummaryEls = await summaryPane.$$(':scope > span');

    readStyleSummaryEls.forEach(async (el, index) => {
        const text = await el.innerText();
        readStyleSummary = `${readStyleSummary}${index === 0 ? '' : ' '}${text}`;
    });

    const currentlyReading = await parseSectionBooks(sections[0]);
    const recentlyRead = await parseSectionBooks(sections[1]);
    const toReadPilePaneTitle = await sections[2].$(':scope > h2')
    const toReadCountText = await toReadPilePaneTitle.innerText();
    const toReadCount = parseInt(toReadCountText.replace(/\D+/g, ""), 10) || 0;

    return { currentlyReading, recentlyRead, readStyleSummary, toReadCount };
}

const parseBooksPageData = (isFavPage) => async (page) => {
    const panes = isFavPage ? await page.$$('#favorites-list .book-pane') : await page.$$('#up-next-book-panes .book-pane');
    const booksData = [];
    for (const pane of panes) {
        let tags = [];
        if (isFavPage) {
            const tagSectionEl = await pane.$('.book-pane-tag-section');
            const tagEls = await tagSectionEl.$$(':scope > div:first-of-type > span.text-teal-700');
            if (!tagEls) {
                console.log('Err: Unable to parse book pane tags section')
            }
            for (const t of tagEls) {
                const text = await t.innerText();
                if (text && text.length) {
                    tags.push(text);
                }
            }
        }

        const imgEl = await pane.$('.book-cover img');
        const linkEl = await pane.$('.book-cover a');
        const editionInfoEl = await pane.$('.toggle-edition-info-link');
        const bookData = await parseBookData(linkEl, imgEl, editionInfoEl);

        booksData.push({ ...bookData, tags });
    }

    if (isFavPage) {
        booksData.sort((a, b) => {
            return Number(b.publishYear) - Number(a.publishYear);
        });
    }

    return booksData;
}


const parseGamesPageData = async (page) => {
    const gameEls = await page.$$('#app-Profile .user-container .list-unordered-base li>div');
    const lastPlayedGames = gameEls.slice(0, 3);
    const gamesData = [];

    for (const gameEl of lastPlayedGames) {
        const titleEl = await gameEl.$('.game-info .box h3 a[href^="https://www.exophase.com/game/"]');
        const imgEl = await gameEl.$('.col-image .image img');
        const lastPlayedEl = await gameEl.$('.lastplayed');
        const totalPlayedEl = await gameEl.$('.game-info .box .hours');
        const platformEl = await gameEl.$('.game-info .box .platforms .inline-pf');

        const title = await titleEl.innerText();
        const imgUrl = (await imgEl.getAttribute('src')).replace(/(games\/)./, "$1l");
        const lastPlayed = await lastPlayedEl.innerText();
        const totalPlaytime = await totalPlayedEl.innerText();
        const platform = await platformEl.innerText();

        gamesData.push({
            title,
            imgUrl,
            lastPlayed,
            totalPlaytime,
            platform,
            url: `${GAME_SEARCH_BASE_URL}${encodeURIComponent(title)}`,
        });
    }

    return gamesData;
};

const createBooksPageUrl = (path) => `${BOOKS_BASE_URL}/${path}/${BOOKS_ID}`;

const PAGES_CONFIG = [
    {
        url: createBooksPageUrl('profile'),
        parser: parseBooksProfileSectionData,
        dKey: 'main',
    },
    {
        url: createBooksPageUrl('to-read'),
        parser: parseBooksPageData(false),
        dKey: 'toRead'
    },
    {
        url: createBooksPageUrl('favorites'),
        parser: parseBooksPageData(true),
        dKey: 'favorites'
    },
    {
        url: GAMES_URL,
        parser: parseGamesPageData,
        dKey: 'games'
    }
];


const LAUNCH_OPTIONS = {
    headless: IS_DEV ? true : chromiumLambda.headless,
    args: IS_DEV ? [
        '--no-first-run',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-extensions'
    ] : chromiumLambda.args,
}

const PAGE_OPTIONS = {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    locale: 'en-US',
    timezoneId: 'America/Los_Angeles',
    viewport: { width: 1440, height: 850 },
};

exports.handler = async (event) => {
    const s3 = new S3Client({ region: S3_REGION });
    const existingFileRes = await s3.send(new GetObjectCommand({
        Bucket: S3_BUCKET_NAME,
        Key: `${S3_BUCKET_DIR}/data.json`
    }));
    const existingFileResJsonString = await existingFileRes.Body?.transformToString();
    let existingData = {};

    try {
        existingData = JSON.parse(existingFileResJsonString);
    } catch (err) {
        console.log("Invalid JSON in fetching existing S3 file");
    }

    const browser = await chromium.launch({
        ...LAUNCH_OPTIONS,
        executablePath: IS_DEV ? DEV_CHROMIUM_PATH : await chromiumLambda.executablePath()
    });
    const context = await browser.newContext(PAGE_OPTIONS);

    const finalPayload = {};

    for (const { url, parser, dKey } of PAGES_CONFIG) {
        const page = await context.newPage();

        try {
            await page.goto(url, { waitUntil: 'domcontentloaded' });
            const sectionData = await parser(page);

            const notProfileSection = dKey !== 'main';

            if (notProfileSection) {
                if (isEmpty(sectionData)) {
                    console.log(`Current scrap received empty data at section: ${dKey}`);
                    finalPayload[dKey] = existingData[dKey];
                } else {
                    finalPayload[dKey] = sectionData;
                }

                continue;
            }

            finalPayload.main = {};

            for (const cat of Object.keys(sectionData)) {
                if (isEmpty(finalPayload.main[cat])) {
                    console.log(`Current scrap received empty data at main: ${cat}`);
                    finalPayload.main[cat] = existingData.main[cat];
                } else {
                    finalPayload.main[cat] = sectionData[cat];
                }
            }


        } finally {
            await page.close();
        }
    }

    await browser.close();

    if (IS_DEV && !ARGV.includes(S3_UPLOAD_FLAG)) {
        console.log('scrapped output:');
        console.log(finalPayload);
        return 'Local run completed';
    };

    try {
        const res = await s3.send(new PutObjectCommand({
            Bucket: S3_BUCKET_NAME,
            Key: `${S3_BUCKET_DIR}/data.json`,
            Body: JSON.stringify(finalPayload),
            ContentType: "application/json",
        }));

        const now = new Date();
        const logOutput = `
            Data refreshed successfully:
            Timestamp: ${now.toISOString()}
            ETag: ${res.ETag}
        `;
        console.log(logOutput)

        return {
            statusCode: 200,
            body: logOutput
        };
    } catch (err) {
        const now = new Date();
        const logOutput = `
            Error uploading data
            Timestamp: ${now.toISOString()}
            ${err}
        `;
        console.log(logOutput);
        return {
            statusCode: 500,
            body: logOutput
        };
    }
};

if (IS_DEV) {
    exports.handler({}).then(result => {
        console.log(result);
    }).catch(err => {
        console.error("Local test error:", err);
    });
}