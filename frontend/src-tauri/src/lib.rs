mod generated_brand;

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrandConfigResponse {
    pub brand_id: &'static str,
    pub product_name: &'static str,
    pub tagline: &'static str,
    pub company_name: &'static str,
    pub bundle_identifier: &'static str,
    pub deep_link_scheme: &'static str,
    pub storage_dir_name: &'static str,
    pub sqlite_file_name: &'static str,
    pub license_type: &'static str,
    pub manifest_json: &'static str,
}

#[tauri::command]
fn get_brand_config() -> BrandConfigResponse {
    BrandConfigResponse {
        brand_id: generated_brand::BRAND_ID,
        product_name: generated_brand::PRODUCT_NAME,
        tagline: generated_brand::TAGLINE,
        company_name: generated_brand::COMPANY_NAME,
        bundle_identifier: generated_brand::BUNDLE_IDENTIFIER,
        deep_link_scheme: generated_brand::DEEP_LINK_SCHEME,
        storage_dir_name: generated_brand::STORAGE_DIR_NAME,
        sqlite_file_name: generated_brand::SQLITE_FILE_NAME,
        license_type: generated_brand::LICENSE_TYPE,
        manifest_json: generated_brand::BRAND_MANIFEST_JSON,
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![get_brand_config])
        .run(tauri::generate_context!())
        .expect("error while running Use Memo");
}
