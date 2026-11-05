// ტელეფონის სტანდარტი — ზუსტად იგივე, რაც CRM-ში.
//
// ⚠️ ეს ფაილი ხელით არ იწერება. CRM-ის index.html-იდან გენერირდება, რომ
// საიტის პასუხი და ოპერატორის პასუხი ერთმანეთს არ დაშორდეს. წესის შეცვლისას
// ჯერ CRM შეასწორე, მერე ეს ფაილი თავიდან დააგენერირე (იხ. tools/sync-phone-filter.sh).
//
// phCheck(raw) → true = ვარგისი · false = არ გვაწყობს · null = ვერ ვცნობთ

const PH_TR = {ა:"a",ბ:"b",გ:"g",დ:"d",ე:"e",ვ:"v",ზ:"z",თ:"t",ი:"i",კ:"k",ლ:"l",მ:"m",
  ნ:"n",ო:"o",პ:"p",ჟ:"j",რ:"r",ს:"s",ტ:"t",უ:"u",ფ:"p",ქ:"q",ღ:"g",ყ:"k",
  შ:"sh",ჩ:"ch",ც:"c",ძ:"dz",წ:"w",ჭ:"ch",ხ:"x",ჯ:"j",ჰ:"h"};
function phNorm(m) {
  return String(m||"").trim().toLowerCase().replace(/i̇/g,"i")
    .split("").map(c => PH_TR[c] ?? c).join("")
    .replace(/[^a-z0-9+]+/g," ").replace(/\s+/g," ").trim();
}
const PH_BRAND_KW = [
  ["iphone",  ["iphone","ipone","iphon","ifon","ipon","aipon","aipin","ajfon","iohone","lphone","ipome","aigon","aifon","ifhone","apple","i phone","iponi","aiponi","ipoun","ifoni","aphone","apon","ippne","iopne","ipohne","ilhone","auponi","aupon","iphoe","ipjone","ifoun"]],
  ["xiaomi",  ["xiaomi","xiami","xiamo","xiamon","xiamen","xsiaomi","ksiaom","qsiaom","qsiaum","qsaom","siaom","shaom","redmi","redme","redmy","redmo","redni","remi","poco","poko","pocco","pako","proko","redmagic","edemi","xaumi","xiaumi","readmi","rebmi","resmi","redm","poqo","xaom"]],
  ["samsung", ["samsung","samsun","samsu","sams","samsyng","samsund","samsudg","sansung","damsung","samsub","samsum","samsul","samaung","aamaung","samung","samsng","galax","galaqs","galaqc","galags","galasy","galaksi","galsk","galqs","galxy","galacy","galaci","galaxs","galaksy","smsung","sasung","sqmsun","galqxsi","samzung","saungi","galaks","gakaxy","galazy","galaqsi","galagsi","galaxi","calaxy","calaxi","galaqai","galsqs","galaxv","samsugi","samsumgi","samsingi","samsumg","samsing"]],
  ["pixel",   ["pixel","pixsel","piqsel","fiqsel","google","gogle","gugl","googl","fixel","piksel","guggl","px "]],
  ["honor",   ["honor","honir","hinor","nohor","onor","honkr","honos"]],
  ["huawei",  ["huawei","huavei","huwei"]],
  ["realme",  ["realme","realmi","realmy","really","real me","realm "]],
  ["oppo",    ["oppo"]],
  ["vivo",    ["vivo"]],
  ["nokia",   ["nokia","nokya"]],
  ["infinix", ["infinix","infiniks","inpiniq","inpiniks"]],
  ["tecno",   ["tecno","teqno","texno"]],
  ["motorola",["motorola","motorika","moto "]],
  ["oneplus", ["oneplus","one plus","one plius","vanplus","vanplas"]],
  ["nothing", ["nothing","noting"]],
  // დანარჩენი ბრენდები სიაში საერთოდ არ არის — ერთ კალათაში
  ["other",   ["oukitel","oukit","aukitel","itel","zte","ulefon","doogee","blackview","alcatel","olkatel","umidigi","cubot","meizu","asus","soni","sony","htc","leeco","wiko","hotwav","tank ","cat","hundai","ulephon","aukateli","xplore"]],
];
const PH_UNK = ["არ ვიცი","ar vici","ანდროიდი","android","უცნობი","ar maqvs","არ მაქვს","არ მახსოვს"];
const PH_NOMODEL = /^\s*(samsung|samsungi|სამსუნგი?|galaxy|გალაქსი?|xiaomi|ქსიაომი|სამსუნგ\s+გალაქსი?)[\s.]*$/i;
const PH_JUNK = /^(|x|ki|diax|ok|ara|sxva[a-z ]*|androidi?|ucnobi|telefoni|ubralo telefoni|smarti|smartponi|tbilisi|diasaxlisi|[0-9 +]{6,})$/;
function phBrand(t) {
  for (const [b, kws] of PH_BRAND_KW) if (kws.some(k => t.includes(k))) return b;
  // ბრენდის გარეშე დაწერილი აიფონი — „13 pro", „17 პრო მაქსი", „11"
  if (/^1[0-8]\b/.test(t) && /pro|max|maqs|mini|plus|pliu|^1[0-8]$/.test(t)) return "iphone";
  if (/^1[0-8](pro|max|maqs|mini|plus)/.test(t)) return "iphone";
  if (/^ip\s?1[0-8]\b/.test(t)) return "iphone";                    // „Ip13"
  if (/^(x|xr|xs|se|[5-9])\s*(s|plus|max|mini)?$/.test(t)) return "iphone";
  // ბრენდის გარეშე დაწერილი სამსუნგი — „s23 ultra", „a16", „note 20"
  if (/^(s|a|m|j|z)\s?\d/.test(t) || /^note\s?\d/.test(t)) return "samsung";
  return null;
}
const PH_ALLOW = {
  // iPhone — 11-დან 18-ის ჩათვლით ვარგისია. ძველები (X, XR, XS, SE, 8 და ქვემოთ)
  // ცნობილი მოდელებია და სტანდარტს არ აკმაყოფილებს, ანუ უარი.
  // მხოლოდ „აიფონი" მოდელის გარეშე რჩება დასაზუსტებელი.
  iphone: t => {
    if (/1[1-8]/.test(t)) return true;
    if (/(?<![a-z0-9])(xr|xs|se|x|[4-9])(?![a-z0-9])/.test(t) || /\d/.test(t)) return false;
    return null;
  },
  // Galaxy S20–S26 (FE / Ultra / + / Active / Slim), Note 20, A51–A57, A72, M31(s), Z Flip3/5/6/7, Z Fold4/5/6/7
  samsung: t => {
    if (!/\d/.test(t)) return null;
    if (/note\s?20(?!\d)/.test(t)
     || /flip\s?[3567](?!\d)/.test(t)
     || /fold\s?[4567](?!\d)/.test(t)
     || /(?<!\d)s\s?2[0-6](?!\d)/.test(t)
     || /(?<!\d)a\s?(5[1-7]|72)(?!\d)/.test(t)
     || /(?<!\d)m\s?31(?!\d)/.test(t)) return true;
    if (/(?<![a-z0-9])[asmjz]\s?\d|note\s?\d|flip\s?\d|fold\s?\d/.test(t)) return false;
    // სერიის ასო არ წერია — „სამსუნგი 56". ციფრიდან გამოვითვლით:
    // S სერია მხოლოდ 20–26-ია, Note 20, M31, Flip 3–7, Fold 4–7.
    // ამ ციფრებზე სერია ვერ გამოიცნობა; ყველა სხვაზე მხოლოდ A სერია არსებობს.
    const n = (t.match(/(?<!\d)(\d{1,2})(?!\d)/) || [])[1];
    if (!n) return null;
    if (/^(2[0-6]|31|[3-7])$/.test(n)) return null;
    return /^(5[1-7]|72)$/.test(n);
  },
  // Pixel 7a, 7 Pro, 8/8a/8 Pro, 9/9a/9 Pro/9 Pro XL, 10/10 Pro — უბრალო Pixel 7 სიაში არ არის
  pixel: t => !/\d/.test(t) ? null : (
       /(?<!\d)7\s?a(?!\d)/.test(t)
    || (/(?<!\d)7(?!\d)/.test(t) && /pro/.test(t))
    || /(?<!\d)(8|9|10)(?!\d)/.test(t)),
  infinix:  t => /hot\s?30/.test(t),          // Infinix Hot 30i
  motorola: t => /razr/.test(t) && /ultra/.test(t),   // Motorola Razr Ultra (2025)
  nothing:  t => /2\s?a/.test(t) && /plus/.test(t),   // Nothing Phone (2a) Plus
  oneplus:  t => /open/.test(t),              // OnePlus Open
};
function phCheck(raw) {
  const t = phNorm(raw);
  if (!t || PH_JUNK.test(t)) return null;
  const b = phBrand(t);
  if (!b) return null;                        // უცნობი ჩანაწერი — არ ვჭრით
  const rule = PH_ALLOW[b];
  return rule ? rule(t) : false;              // ბრენდი ცნობილია, სიაში არ არის → უარი
}

window.phCheck = phCheck;
