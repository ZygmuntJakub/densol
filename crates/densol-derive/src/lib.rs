use proc_macro::TokenStream;
use proc_macro2::Span;
use quote::quote;
use syn::{parse_macro_input, Data, DeriveInput, Fields, Ident, Type};

/// Derive `set_<field>` / `get_<field>` helpers for fields marked `#[compress]`.
///
/// The compression strategy is resolved via a `Strategy` type alias that must be
/// in scope at the call site:
///
/// ```ignore
/// use densol::Lz4 as Strategy;
///
/// #[account]
/// #[derive(Compress)]
/// pub struct DataStore {
///     #[compress]
///     pub data: Vec<u8>,
/// }
/// // generates:
/// //   fn set_data(&mut self, raw: &[u8]) -> Result<(), densol::CompressionError>
/// //   fn get_data(&self)                 -> Result<Vec<u8>, densol::CompressionError>
/// ```
#[proc_macro_derive(Compress, attributes(compress))]
pub fn derive_compress(input: TokenStream) -> TokenStream {
    let input = parse_macro_input!(input as DeriveInput);
    match expand(input) {
        Ok(ts)  => ts.into(),
        Err(e)  => e.to_compile_error().into(),
    }
}

fn expand(input: DeriveInput) -> syn::Result<proc_macro2::TokenStream> {
    let struct_name = &input.ident;

    let fields = match &input.data {
        Data::Struct(s) => match &s.fields {
            Fields::Named(f) => &f.named,
            _ => return Err(syn::Error::new(
                Span::call_site(),
                "#[derive(Compress)] only supports structs with named fields",
            )),
        },
        _ => return Err(syn::Error::new(
            Span::call_site(),
            "#[derive(Compress)] only supports structs",
        )),
    };

    let mut methods = Vec::new();

    for field in fields {
        // Only process fields tagged with #[compress]
        let has_attr = field.attrs.iter().any(|a| a.path().is_ident("compress"));
        if !has_attr {
            continue;
        }

        let field_name = field.ident.as_ref().expect("named field");
        let set_name = Ident::new(&format!("set_{}", field_name), field_name.span());
        let get_name = Ident::new(&format!("get_{}", field_name), field_name.span());

        // Validate field type is Vec<u8>
        if !is_vec_u8(&field.ty) {
            return Err(syn::Error::new_spanned(
                &field.ty,
                "#[compress] field must be of type Vec<u8>",
            ));
        }

        methods.push(quote! {
            pub fn #set_name(
                &mut self,
                raw: &[u8],
            ) -> ::core::result::Result<(), ::densol::CompressionError> {
                self.#field_name = <Strategy as ::densol::Compressor>::compress(raw)?;
                ::core::result::Result::Ok(())
            }

            pub fn #get_name(
                &self,
            ) -> ::core::result::Result<
                ::std::vec::Vec<u8>,
                ::densol::CompressionError,
            > {
                <Strategy as ::densol::Compressor>::decompress(&self.#field_name)
            }
        });
    }

    if methods.is_empty() {
        return Err(syn::Error::new(
            Span::call_site(),
            "#[derive(Compress)] found no fields tagged with #[compress]",
        ));
    }

    Ok(quote! {
        const _: () = {
            // Trait-bound check so rustc names the problem clearly:
            //   "the trait bound `X: Compressor` is not satisfied"
            // or, if `Strategy` is missing entirely:
            //   "cannot find type `Strategy` in this scope"
            //
            // Fix: add `use densol::Lz4 as Strategy;`
            // (or `Identity`) before the struct that derives `Compress`.
            #[allow(dead_code)]
            fn __compress_derive_strategy_check<T: ::densol::Compressor>() {}
            #[allow(dead_code)]
            fn __compress_derive_assert() { __compress_derive_strategy_check::<Strategy>() }
        };

        impl #struct_name {
            #(#methods)*
        }
    })
}

/// Returns true if `ty` is `Vec<u8>` or `std::vec::Vec<u8>` / `alloc::vec::Vec<u8>`.
fn is_vec_u8(ty: &Type) -> bool {
    let Type::Path(tp) = ty else { return false };
    let seg = match tp.path.segments.last() {
        Some(s) => s,
        None => return false,
    };
    if seg.ident != "Vec" {
        return false;
    }
    let syn::PathArguments::AngleBracketed(ref args) = seg.arguments else {
        return false;
    };
    let Some(syn::GenericArgument::Type(Type::Path(inner))) = args.args.first() else {
        return false;
    };
    inner.path.is_ident("u8")
}
